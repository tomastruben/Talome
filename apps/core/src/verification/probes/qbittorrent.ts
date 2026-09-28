/**
 * qBittorrent probe — login works, a save path is set, and every *arr that
 * uses qBittorrent can actually see where it saves.
 */

import { appRequest, getAppName, qbtLogin, resolveConnection, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import { ARR_APPS } from "./arr.js";
import { displayUrl, listPreview, notConfiguredOutcome, plural } from "./common.js";
import { combineOutcomes, evaluateDownloadPathMapping, getQbtSavePaths } from "./path-mapping.js";

export async function evaluateQbtLogin(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const conn = resolveConnection(ctx.env, "qbittorrent");
  if (!conn) return notConfiguredOutcome(ctx, "qbittorrent");
  const session = await qbtLogin(ctx);
  if (!session.ok) {
    if (session.status === 0) {
      return outcome.fail(
        `qBittorrent did not answer at ${displayUrl(conn.baseUrl)}: ${session.error ?? "no response"}.`,
        "Check that the qBittorrent container is running and qbittorrent_url is correct.",
      );
    }
    return outcome.fail(
      `qBittorrent login failed: ${session.error ?? `HTTP ${session.status}`}.`,
      "Save the current qBittorrent Web UI password as qbittorrent_password (and qbittorrent_username if not 'admin'). New qBittorrent versions print a temporary password in the container log on first start.",
    );
  }
  const version = await appRequest(ctx, "qbittorrent", "/api/v2/app/version");
  const versionText = version.ok && typeof version.data === "string" ? ` ${version.data.trim()}` : "";
  return outcome.pass(`Logged in to qBittorrent${versionText} as ${conn.username ?? "admin"} (${displayUrl(conn.baseUrl)}).`);
}

export async function evaluateQbtSavePath(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const { savePath, categories, error } = await getQbtSavePaths(ctx);
  if (!savePath) {
    return outcome.fail(`qBittorrent has no default save path${error ? ` (${error})` : ""}.`, "Set a default save path in qBittorrent → Options → Downloads (e.g. /downloads).");
  }
  const withPaths = Object.entries(categories)
    .filter(([, c]) => c.savePath)
    .map(([name, c]) => `${name} → ${c.savePath}`);
  const catText = Object.keys(categories).length > 0
    ? `; ${plural(Object.keys(categories).length, "category", "categories")}${withPaths.length > 0 ? ` (${listPreview(withPaths, 3)})` : ""}`
    : "";
  return outcome.pass(`Default save path ${savePath}${catText}.`);
}

export async function evaluateQbtArrConsistency(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const arrs = ARR_APPS.filter((id) => resolveConnection(ctx.env, id));
  if (arrs.length === 0) return outcome.skip("No Sonarr/Radarr/Readarr connected to Talome to compare against.");
  const parts: Array<{ label: string; outcome: CheckOutcome }> = [];
  for (const arrId of arrs) {
    parts.push({ label: getAppName(arrId), outcome: await evaluateDownloadPathMapping(ctx, arrId) });
  }
  return combineOutcomes(parts, "No *arr app uses qBittorrent.");
}

export function qbittorrentChecks(): CheckDefinition[] {
  return [
    { id: "login", label: "Web UI login works", critical: true, appId: "qbittorrent", run: evaluateQbtLogin },
    { id: "save-path", label: "Save path configured", appId: "qbittorrent", dependsOn: ["login"], run: evaluateQbtSavePath },
    {
      id: "arr-save-path",
      label: "Save path visible to the *arr apps",
      appId: "qbittorrent",
      dependsOn: ["save-path"],
      timeoutMs: 20_000,
      run: evaluateQbtArrConsistency,
    },
  ];
}
