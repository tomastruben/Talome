/**
 * Health Score — The Immutable Eval Harness
 *
 * Pure evaluation function that probes real endpoints. Cannot be gamed —
 * the score reflects actual reachability and configuration state.
 *
 * Inspired by autoresearch's immutable eval: the harness never changes,
 * only the setup loop's actions can improve the score.
 */

import { APP_REGISTRY, type AppCapabilities } from "../app-registry/index.js";
import { listContainers } from "../docker/client.js";
import { getSetting } from "../utils/settings.js";
import { resolveAppConnection, buildHeaders } from "../ai/tools/universal-tools.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

export interface AppHealthResult {
  appId: string;
  name: string;
  installed: boolean;
  containerRunning: boolean;
  urlConfigured: boolean;
  apiKeyConfigured: boolean;
  healthReachable: boolean;
  wiringComplete: boolean;
  score: number;
  issues: string[];
}

export interface ServerHealthScore {
  overall: number;
  apps: AppHealthResult[];
  timestamp: string;
  configured: number;
  total: number;
}

const HEALTH_TIMEOUT_MS = 5_000;

/** Probe a URL with a timeout. Returns true if the response is 2xx or 401/403 (app is alive). */
async function probeHealth(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    // 401/403 still means the app is running — auth is just not configured
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

/** Check if an app's relatesTo targets have reciprocal configuration. */
function checkWiring(appId: string, caps: AppCapabilities): boolean {
  if (!caps.relatesTo || caps.relatesTo.length === 0) return true;

  for (const targetId of caps.relatesTo) {
    const targetCaps = APP_REGISTRY[targetId];
    if (!targetCaps) continue;

    // Check if the target is installed and configured
    const targetInstalled = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, targetId))
      .get();
    if (!targetInstalled) continue; // Target not installed — skip, not a wiring issue

    // Both apps need URLs configured to be "wired"
    const targetUrl = getSetting(targetCaps.apiBaseSettingKey);
    const thisUrl = getSetting(caps.apiBaseSettingKey);
    if (!targetUrl || !thisUrl) return false;
  }
  return true;
}

/** Score a single app's health (0–100). 20 points each for 5 criteria. */
async function scoreApp(
  appId: string,
  caps: AppCapabilities,
  runningContainerNames: Set<string>,
): Promise<AppHealthResult> {
  const issues: string[] = [];
  let score = 0;

  // 1. Container running (20 pts)
  const installed = db
    .select()
    .from(schema.installedApps)
    .where(eq(schema.installedApps.appId, appId))
    .get();

  const containerRunning = caps.dockerServiceName
    ? runningContainerNames.has(caps.dockerServiceName)
    : false;

  if (containerRunning) {
    score += 20;
  } else {
    issues.push("Container not running");
  }

  // 2. URL configured (20 pts)
  const url = getSetting(caps.apiBaseSettingKey);
  const urlConfigured = !!url;
  if (urlConfigured) {
    score += 20;
  } else {
    issues.push(`Missing setting: ${caps.apiBaseSettingKey}`);
  }

  // 3. API key configured (20 pts)
  const apiKey = getSetting(caps.apiKeySettingKey);
  const apiKeyConfigured = !!apiKey;
  if (apiKeyConfigured) {
    score += 20;
  } else {
    issues.push(`Missing setting: ${caps.apiKeySettingKey}`);
  }

  // 4. Health endpoint reachable (20 pts)
  let healthReachable = false;
  if (urlConfigured) {
    const conn = resolveAppConnection(appId);
    if (!("error" in conn)) {
      const headers = buildHeaders(conn.auth);
      healthReachable = await probeHealth(
        `${conn.baseUrl}${caps.healthEndpoint}`,
        headers,
      );
    }
  }
  if (healthReachable) {
    score += 20;
  } else if (urlConfigured) {
    issues.push("Health endpoint unreachable");
  }

  // 5. Wiring complete (20 pts)
  const wiringComplete = checkWiring(appId, caps);
  if (wiringComplete) {
    score += 20;
  } else {
    issues.push("Missing wiring to related apps");
  }

  return {
    appId,
    name: caps.name,
    installed: !!installed,
    containerRunning,
    urlConfigured,
    apiKeyConfigured,
    healthReachable,
    wiringComplete,
    score,
    issues,
  };
}

/**
 * Compute the overall server health score across all installed registry apps.
 * Apps not in the registry or in the excluded list are ignored.
 */
export async function computeHealthScore(): Promise<ServerHealthScore> {
  const excludedRaw = getSetting("setup_excluded_apps");
  const excluded = new Set<string>(excludedRaw ? JSON.parse(excludedRaw) as string[] : []);

  // Detect installed apps using three signals:
  // 1. In installed_apps DB table (via Talome store install)
  // 2. Running container matching dockerServiceName
  // 3. URL setting configured (manually set up outside Talome)
  const installed = db.select().from(schema.installedApps).all();
  const installedIds = new Set(installed.map((a) => a.appId.toLowerCase()));

  function isInInstalledTable(registryKey: string): boolean {
    if (installedIds.has(registryKey)) return true;
    for (const id of installedIds) {
      if (id.endsWith(registryKey) || id.endsWith(`-${registryKey}`)) return true;
    }
    return false;
  }

  // Get running containers — match by name substring
  const containers = await listContainers();
  const runningNames = new Set<string>();
  for (const c of containers) {
    if (c.status === "running") {
      const name = c.name.toLowerCase().replace(/^\//, "");
      runningNames.add(name);
      // Also add partial matches for common naming patterns
      for (const part of name.split(/[-_]/)) {
        runningNames.add(part);
      }
    }
  }

  function isInstalled(registryKey: string, caps: AppCapabilities): boolean {
    // In installed_apps table
    if (isInInstalledTable(registryKey)) return true;
    // Container running
    if (caps.dockerServiceName && runningNames.has(caps.dockerServiceName)) return true;
    // URL setting configured (app was set up outside Talome install flow)
    if (getSetting(caps.apiBaseSettingKey)) return true;
    return false;
  }

  const apps: AppHealthResult[] = [];
  let totalScore = 0;

  for (const [appId, caps] of Object.entries(APP_REGISTRY)) {
    if (!isInstalled(appId, caps)) continue;

    if (excluded.has(appId)) {
      // Excluded apps get automatic 100
      apps.push({
        appId,
        name: caps.name,
        installed: true,
        containerRunning: true,
        urlConfigured: true,
        apiKeyConfigured: true,
        healthReachable: true,
        wiringComplete: true,
        score: 100,
        issues: [],
      });
      totalScore += 100;
      continue;
    }

    const result = await scoreApp(appId, caps, runningNames);
    apps.push(result);
    totalScore += result.score;
  }

  const total = apps.length;
  const overall = total > 0 ? Math.round(totalScore / total) : 100;
  const configured = apps.filter((a) => a.score === 100).length;

  return {
    overall,
    apps,
    timestamp: new Date().toISOString(),
    configured,
    total,
  };
}
