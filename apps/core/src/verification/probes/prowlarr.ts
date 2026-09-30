/**
 * Prowlarr probe — indexers configured and synced to the *arr apps.
 */

import { z } from "zod";
import { appRequest, getAppName, resolveConnection, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import { ARR_APPS, arrPath, getArrHealth } from "./arr.js";
import { apiReachableCheck, httpFailure, listPreview, parseOr, plural, versionSchema } from "./common.js";

const indexerSchema = z.array(z.object({ name: z.string().optional(), enable: z.boolean().optional() }));
const indexerStatusSchema = z.array(
  z.object({ indexerId: z.number().optional(), disabledTill: z.string().nullable().optional() }),
);
const applicationSchema = z.array(
  z.object({
    name: z.string().optional(),
    implementation: z.string().optional(),
    syncLevel: z.string().optional(),
  }),
);

export async function evaluateProwlarrIndexers(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const res = await appRequest(ctx, "prowlarr", arrPath("prowlarr", "/indexer"));
  if (!res.ok) return httpFailure(ctx, "prowlarr", res, "listing indexers");
  const indexers = parseOr(indexerSchema, res.data);
  if (!indexers) return outcome.fail("Prowlarr returned an unexpected indexer list.");
  const enabled = indexers.filter((i) => i.enable !== false);
  if (enabled.length === 0) {
    return outcome.fail(
      indexers.length === 0 ? "Prowlarr has no indexers configured." : "Prowlarr has indexers, but all are disabled.",
      "Add at least one indexer in Prowlarr (Indexers → Add Indexer). Public trackers work without an account.",
    );
  }
  const statusRes = await appRequest(ctx, "prowlarr", arrPath("prowlarr", "/indexerstatus"));
  const statuses = statusRes.ok ? parseOr(indexerStatusSchema, statusRes.data) ?? [] : [];
  const now = ctx.env.now();
  const backedOff = statuses.filter((s) => s.disabledTill && Date.parse(s.disabledTill) > now).length;
  const summary = `${plural(enabled.length, "indexer")} enabled: ${listPreview(enabled.map((i) => i.name ?? "unnamed"))}`;
  if (backedOff > 0) {
    return outcome.warn(
      `${summary}; ${plural(backedOff, "indexer")} temporarily disabled after failures.`,
      "Open Prowlarr → Indexers and test the failing ones (site down, captcha, or expired credentials).",
    );
  }
  return outcome.pass(`${summary}.`);
}

export async function evaluateProwlarrAppSync(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const res = await appRequest(ctx, "prowlarr", arrPath("prowlarr", "/applications"));
  if (!res.ok) return httpFailure(ctx, "prowlarr", res, "listing synced applications");
  const apps = parseOr(applicationSchema, res.data);
  if (!apps) return outcome.fail("Prowlarr returned an unexpected application list.");

  const syncing = apps.filter((a) => a.syncLevel !== "disabled");
  const syncedImpls = new Set(syncing.map((a) => (a.implementation ?? a.name ?? "").toLowerCase()));
  const configuredArrs = ARR_APPS.filter((id) => resolveConnection(ctx.env, id));
  const missing = configuredArrs.filter((id) => !syncedImpls.has(id));

  if (syncing.length === 0) {
    return outcome.fail(
      configuredArrs.length > 0
        ? `Prowlarr is not syncing indexers to ${listPreview(configuredArrs.map(getAppName))}.`
        : "Prowlarr is not syncing indexers to any app.",
      "Register the *arr apps in Prowlarr (Settings → Apps) — ask the assistant to run arr_sync_indexers_from_prowlarr.",
    );
  }

  const health = await getArrHealth(ctx, "prowlarr");
  const appErrors = (health ?? [])
    .filter((h) => (h.source === "ApplicationStatusCheck" || h.source === "ApplicationLongTermStatusCheck") && h.message)
    .map((h) => h.message!);

  const synced = syncing.map((a) => `${a.name ?? a.implementation}${a.syncLevel ? ` (${a.syncLevel})` : ""}`);
  if (missing.length > 0) {
    return outcome.warn(
      `Prowlarr syncs to ${listPreview(synced)}, but not to ${listPreview(missing.map(getAppName))}.`,
      `Add ${listPreview(missing.map(getAppName))} in Prowlarr → Settings → Apps so they receive indexers.`,
    );
  }
  if (appErrors.length > 0) {
    return outcome.warn(`Prowlarr syncs to ${listPreview(synced)}, but reports: ${listPreview(appErrors, 2)}`, "Check the app URL and API key in Prowlarr → Settings → Apps.");
  }
  return outcome.pass(`Prowlarr syncs indexers to ${listPreview(synced)}.`);
}

export function prowlarrChecks(): CheckDefinition[] {
  return [
    apiReachableCheck("prowlarr", arrPath("prowlarr", "/system/status"), (data) => {
      const v = parseOr(versionSchema, data)?.version;
      return `Prowlarr${v ? ` ${v}` : ""} answered and accepted the API key`;
    }),
    { id: "indexers", label: "Indexers configured", appId: "prowlarr", dependsOn: ["api"], run: evaluateProwlarrIndexers },
    { id: "app-sync", label: "Indexers synced to *arr apps", appId: "prowlarr", dependsOn: ["api"], run: evaluateProwlarrAppSync },
  ];
}
