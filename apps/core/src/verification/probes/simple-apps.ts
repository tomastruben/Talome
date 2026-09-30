/**
 * Probes for Audiobookshelf and Home Assistant.
 */

import { z } from "zod";
import { appRequest, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import { apiReachableCheck, httpFailure, listPreview, parseOr, plural } from "./common.js";

// ── Audiobookshelf ───────────────────────────────────────────────────────────

const absMeSchema = z.object({ username: z.string().optional(), type: z.string().optional() });
const absLibrariesSchema = z.object({
  libraries: z.array(
    z.object({
      name: z.string().optional(),
      mediaType: z.string().optional(),
      folders: z.array(z.object({ fullPath: z.string() })).optional(),
    }),
  ),
});

export async function evaluateAbsLibraries(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const res = await appRequest(ctx, "audiobookshelf", "/api/libraries");
  if (!res.ok) return httpFailure(ctx, "audiobookshelf", res, "listing libraries");
  const parsed = parseOr(absLibrariesSchema, res.data);
  if (!parsed) return outcome.fail("Audiobookshelf returned an unexpected library list.");
  const libs = parsed.libraries;
  if (libs.length === 0) {
    return outcome.fail(
      "Audiobookshelf has no libraries, so there is nothing to listen to.",
      "Create a library pointing at your audiobooks folder — ask the assistant to run audiobookshelf_add_library.",
    );
  }
  const noFolders = libs.filter((l) => (l.folders ?? []).length === 0);
  const names = libs.map((l) => `${l.name ?? "Unnamed"}${l.mediaType ? ` (${l.mediaType})` : ""}, ${plural((l.folders ?? []).length, "folder")}`);
  if (noFolders.length > 0) {
    return outcome.warn(
      `${plural(libs.length, "library", "libraries")}: ${listPreview(names)} — ${listPreview(noFolders.map((l) => l.name ?? "Unnamed"))} has no folder.`,
      "Add a folder to the empty library in Audiobookshelf → Settings → Libraries.",
    );
  }
  return outcome.pass(`${plural(libs.length, "library", "libraries")}: ${listPreview(names)}.`);
}

export function audiobookshelfChecks(): CheckDefinition[] {
  return [
    apiReachableCheck("audiobookshelf", "/api/me", (data) => {
      const me = parseOr(absMeSchema, data);
      return `Audiobookshelf accepted the token${me?.username ? ` (user ${me.username})` : ""}`;
    }),
    { id: "libraries", label: "Libraries configured", appId: "audiobookshelf", dependsOn: ["api"], run: evaluateAbsLibraries },
  ];
}

// ── Home Assistant ───────────────────────────────────────────────────────────

const hassApiSchema = z.object({ message: z.string().optional() });
const hassConfigSchema = z.object({
  version: z.string().optional(),
  state: z.string().optional(),
  safe_mode: z.boolean().optional(),
  recovery_mode: z.boolean().optional(),
  location_name: z.string().optional(),
});

export async function evaluateHassCore(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const res = await appRequest(ctx, "homeassistant", "/api/config");
  if (!res.ok) return httpFailure(ctx, "homeassistant", res, "reading the core config");
  const cfg = parseOr(hassConfigSchema, res.data);
  if (!cfg) return outcome.fail("Home Assistant returned unexpected config data.");
  const label = `Home Assistant ${cfg.version ?? ""}${cfg.location_name ? ` "${cfg.location_name}"` : ""}`.replace(/\s+/g, " ").trim();
  if (cfg.safe_mode || cfg.recovery_mode) {
    return outcome.warn(
      `${label} is running in ${cfg.recovery_mode ? "recovery" : "safe"} mode — custom integrations and automations are not loaded.`,
      "Check Settings → System → Logs in Home Assistant for the configuration error, fix it and restart.",
    );
  }
  if (cfg.state && cfg.state !== "RUNNING") {
    return outcome.warn(`${label} core state is ${cfg.state}.`, "Home Assistant is still starting or stopping — retry in a minute.");
  }
  return outcome.pass(`${label} core is running.`);
}

export function homeAssistantChecks(): CheckDefinition[] {
  return [
    apiReachableCheck("homeassistant", "/api/", (data) => {
      const msg = parseOr(hassApiSchema, data)?.message;
      return `Home Assistant API answered${msg ? ` "${msg}"` : ""} with the saved token`;
    }),
    { id: "core", label: "Core running normally", appId: "homeassistant", dependsOn: ["api"], run: evaluateHassCore },
  ];
}
