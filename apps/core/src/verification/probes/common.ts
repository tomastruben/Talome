import { z } from "zod";
import type { HttpResult } from "../env.js";
import { appRequest, getAppName, resolveConnection, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";

/** Strip userinfo (user:pass@) from a URL before it is shown anywhere. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/\/[^@/]+@/, "//");
  }
}

export function notConfiguredOutcome(ctx: ProbeCallContext, appId: string): CheckOutcome {
  const name = getAppName(appId);
  return outcome.skip(
    `${name} is not connected to Talome (no URL saved in settings).`,
    `Install ${name} from the App Store, or save its URL and API key under Settings → Connections so Talome can verify it.`,
  );
}

/** Turn a failed HTTP call into a precise, actionable outcome. */
export function httpFailure(ctx: ProbeCallContext, appId: string, res: HttpResult, what: string): CheckOutcome {
  const name = getAppName(appId);
  const conn = resolveConnection(ctx.env, appId);
  const where = conn ? displayUrl(conn.baseUrl) : "(no URL)";
  if (res.status === 401 || res.status === 403) {
    return outcome.fail(
      `${name} rejected Talome's credentials while ${what} (HTTP ${res.status}).`,
      conn
        ? `Update the saved credential (${conn.keySettingKey}) in Settings → Connections with a valid ${name} API key.`
        : undefined,
    );
  }
  if (res.status === 0) {
    return outcome.fail(
      `${name} did not answer at ${where} while ${what}: ${res.error ?? "no response"}.`,
      `Check that the ${name} container is running and that ${conn?.urlSettingKey ?? "its URL"} points to it.`,
    );
  }
  return outcome.fail(`${name} returned an error while ${what}: ${res.error ?? `HTTP ${res.status}`}.`);
}

export function parseOr<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function listPreview(items: string[], max = 4): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

/**
 * The first check of every app probe: the app answers its API with Talome's
 * stored credentials. Critical — nothing else is meaningful without it.
 */
export function apiReachableCheck(
  appId: string,
  path: string,
  describe: (data: unknown) => string,
  opts: { requireKey?: boolean; auth?: boolean; label?: string } = {},
): CheckDefinition {
  const name = getAppName(appId);
  return {
    id: "api",
    label: opts.label ?? `${name} API reachable with Talome's credentials`,
    critical: true,
    appId,
    async run(ctx) {
      const conn = resolveConnection(ctx.env, appId);
      if (!conn) return notConfiguredOutcome(ctx, appId);
      if (opts.requireKey !== false && appId !== "qbittorrent" && !conn.apiKey) {
        return outcome.fail(
          `${name} URL is saved but no API key/token is stored (${conn.keySettingKey}).`,
          `Save a ${name} API key as ${conn.keySettingKey} under Settings → Connections.`,
        );
      }
      const res = await appRequest(ctx, appId, path, { auth: opts.auth });
      if (!res.ok) return httpFailure(ctx, appId, res, "checking its API");
      return outcome.pass(`${describe(res.data)} (${displayUrl(conn.baseUrl)}).`);
    },
  };
}

export const versionSchema = z.object({ version: z.string().optional() });
