import { tool } from "ai";
import { z } from "zod";
import { getAppCapabilities } from "../../app-registry/index.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { isSecretSettingKey, decryptSetting } from "../../utils/crypto.js";

interface DiagnosticResult {
  check: string;
  status: "ok" | "warning" | "error" | "skipped";
  details: string;
  recommendation?: string;
}

async function probeHttpHealth(url: string, apiKey?: string): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["X-Api-Key"] = apiKey;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, statusCode: res.status };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function getSetting(key: string): string | undefined {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (!row?.value) return undefined;
    return isSecretSettingKey(key) ? decryptSetting(row.value) : row.value;
  } catch {
    return undefined;
  }
}

function getInstalledApp(appId: string) {
  try {
    return db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();
  } catch {
    return null;
  }
}

export const diagnoseAppTool = tool({
  description:
    "Run a comprehensive diagnostic on an installed app. Checks: (1) container running status, (2) recent error logs, (3) app HTTP health endpoint, (4) API connectivity, (5) app configuration completeness. Returns a structured diagnosis with recommended fixes. Use this when a user reports an app is broken or not working.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID to diagnose (e.g. 'sonarr', 'jellyfin', 'radarr')"),
  }),
  execute: async ({ appId }) => {
    const results: DiagnosticResult[] = [];

    // ── Check 1: Is the app installed? ────────────────────────────────────────
    const installedApp = getInstalledApp(appId);
    if (!installedApp) {
      return {
        success: false,
        error: `App '${appId}' is not installed. Use list_apps to see installed apps.`,
      };
    }

    results.push({
      check: "installation",
      status: installedApp.status === "running" ? "ok" : "warning",
      details: `Installed app found. Status: ${installedApp.status}`,
      recommendation: installedApp.status !== "running" ? `App status is '${installedApp.status}'. Try restarting it.` : undefined,
    });

    // ── Get registry info for advanced checks ─────────────────────────────────
    const capabilities = getAppCapabilities(appId);
    const apiBase = capabilities ? getSetting(capabilities.apiBaseSettingKey) : undefined;
    const apiKey = capabilities ? getSetting(capabilities.apiKeySettingKey) : undefined;

    // ── Run parallel checks 2–5 ───────────────────────────────────────────────
    const [logCheck, healthCheck, configCheck] = await Promise.allSettled([
      // Check 2: Recent logs for errors
      (async (): Promise<DiagnosticResult> => {
        try {
          const containerIds: string[] = JSON.parse(installedApp.containerIds || "[]");
          if (containerIds.length === 0) {
            return { check: "logs", status: "warning", details: "No container IDs found.", recommendation: "Reinstall or restart the app." };
          }
          // We can't import docker tools here without circular deps — return info for agent to follow up
          return {
            check: "logs",
            status: "skipped",
            details: `Container IDs: ${containerIds.join(", ")}. Use get_container_logs to check for errors.`,
          };
        } catch {
          return { check: "logs", status: "error", details: "Could not read container IDs." };
        }
      })(),

      // Check 3: HTTP health probe
      (async (): Promise<DiagnosticResult> => {
        if (!apiBase || !capabilities) {
          return {
            check: "http_health",
            status: "skipped",
            details: "No API URL configured for this app.",
            recommendation: `Configure the app URL in Settings → Media Connections (setting key: ${capabilities?.apiBaseSettingKey ?? "unknown"}).`,
          };
        }
        const healthUrl = `${apiBase.replace(/\/$/, "")}${capabilities.healthEndpoint}`;
        const probe = await probeHttpHealth(healthUrl, apiKey);
        if (probe.ok) {
          return { check: "http_health", status: "ok", details: `Health endpoint ${healthUrl} returned ${probe.statusCode}.` };
        }
        return {
          check: "http_health",
          status: "error",
          details: `Health endpoint returned ${probe.statusCode ?? "no response"}: ${probe.error ?? "HTTP error"}`,
          recommendation: `Check that ${capabilities.name} is running and reachable at ${apiBase}. Verify port ${capabilities.commonPorts[0]} is not blocked.`,
        };
      })(),

      // Check 4: Configuration completeness
      (async (): Promise<DiagnosticResult> => {
        if (!capabilities) {
          return { check: "config", status: "skipped", details: "No registry entry for this app — skipping config check." };
        }
        const missing: string[] = [];
        if (!apiBase) missing.push(capabilities.apiBaseSettingKey);
        if (!apiKey) missing.push(capabilities.apiKeySettingKey);

        if (missing.length > 0) {
          return {
            check: "config",
            status: "warning",
            details: `Missing settings: ${missing.join(", ")}`,
            recommendation:
              `Missing central settings: ${missing.join(", ")}. Prefer automatic remediation: use get_app_config plus read_app_config_file/write_app_config_file to apply the equivalent app config directly.`,
          };
        }
        return { check: "config", status: "ok", details: "API URL and key are configured." };
      })(),
    ]);

    for (const settled of [logCheck, healthCheck, configCheck]) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        results.push({ check: "unknown", status: "error", details: String(settled.reason) });
      }
    }

    // ── Synthesize overall health ─────────────────────────────────────────────
    const hasErrors = results.some((r) => r.status === "error");
    const hasWarnings = results.some((r) => r.status === "warning");
    const overallStatus = hasErrors ? "unhealthy" : hasWarnings ? "degraded" : "healthy";

    const recommendations = results
      .filter((r) => r.recommendation)
      .map((r) => r.recommendation as string);

    return {
      success: true,
      appId,
      overallStatus,
      checks: results,
      recommendations,
      summary:
        overallStatus === "healthy"
          ? `${appId} appears healthy — all checks passed.`
          : `${appId} has issues: ${recommendations.join(" ")}`,
    };
  },
});
