import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import { DEFAULT_SYSTEM_PROMPT } from "../ai/agent.js";
import { getAllToolMeta } from "../ai/tool-registry.js";
import { isSecretSettingKey, encryptSetting } from "../utils/crypto.js";
import { writeAuditEntry } from "../db/audit.js";
import { listContainers, execInContainer } from "../docker/client.js";
import { getUsageSummary, getTodayCostUsd, getDailyCapUsd, getBudgetZone } from "../agent-loop/budget.js";
import { isClaudeCodeAvailable, getClaudeCodeVersion } from "../ai/claude-process.js";
import { serverError } from "../middleware/request-logger.js";

const settings = new Hono();

/* ── Request schemas ─────────────────────────────────────────────────────── */

const settingsUpdateSchema = z.record(z.string(), z.string()).refine(
  (obj) => Object.keys(obj).length <= 50,
  { message: "Too many keys (max 50)" },
);

const serviceTestSchema = z.object({
  service: z.string().min(1).max(50),
  url: z.string().url().max(500),
  apiKey: z.string().max(500).optional(),
});

const systemPromptSchema = z.object({
  prompt: z.string().max(50_000),
});

const toolConfigSchema = z.object({
  disabled: z.array(z.string().max(100)).max(200),
});

const aiCostCapSchema = z.object({
  cap: z.number().min(0).max(10_000),
});

const importConfigSchema = z.object({
  code: z.string().min(1).max(100_000),
});

settings.get("/", (c) => {
  try {
    const rows = db.select().from(schema.settings).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = isSecretSettingKey(row.key) ? "(configured)" : row.value;
    }
    return c.json(result);
  } catch {
    return c.json({});
  }
});

settings.post("/", async (c) => {
  try {
    const parsed = settingsUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    // Wrap in transaction so bulk settings update is atomic — no partial state on crash
    db.transaction((tx) => {
      for (const [key, value] of Object.entries(body)) {
        if (value === "") continue; // skip empty — preserve existing value
        const stored = isSecretSettingKey(key) ? encryptSetting(value) : value;
        tx.insert(schema.settings)
          .values({ key, value: stored })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value: stored } })
          .run();
      }
    });
    writeAuditEntry("settings_changed", "modify", Object.keys(body).join(", "));
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to update settings" });
  }
});

const SERVICE_HEALTH: Record<string, (url: string, apiKey: string) => string> = {
  sonarr:    (url) => `${url}/api/v3/health`,
  radarr:    (url) => `${url}/api/v3/health`,
  prowlarr:  (url) => `${url}/api/v1/health`,
  readarr:   (url) => `${url}/api/v1/health`,
  overseerr: (url) => `${url}/api/v1/status`,
  plex:      (url, token) => `${url}/library/sections?X-Plex-Token=${token}`,
  audiobookshelf: (url) => `${url}/healthcheck`,
  qbittorrent: (url) => `${url}/api/v2/app/version`,
  jellyfin:  (url) => `${url}/System/Info/Public`,
};

// Services that pass auth via query param instead of X-Api-Key header
const QUERY_PARAM_AUTH_SERVICES = new Set(["plex"]);

// Services that use Authorization: Bearer <token> instead of X-Api-Key header
const BEARER_AUTH_SERVICES = new Set(["audiobookshelf"]);

settings.post("/test", async (c) => {
  try {
    const parsed = serviceTestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    const { service, url, apiKey } = parsed.data;

    const healthPath = SERVICE_HEALTH[service];
    if (!healthPath) {
      return c.json({ ok: false, error: `Unknown service: ${service}` }, 400);
    }

    if (service === "plex" && !apiKey) {
      return c.json({ ok: false, error: "Token required — sign in with Plex or auto-detect" });
    }

    // qBittorrent: test via login endpoint with stored credentials
    if (service === "qbittorrent") {
      const base = url.replace(/\/$/, "");
      const rows = await db.select().from(schema.settings).where(
        sql`${schema.settings.key} IN ('qbittorrent_username', 'qbittorrent_password')`,
      );
      const creds: Record<string, string> = {};
      for (const r of rows) creds[r.key] = r.value;
      const loginRes = await fetch(`${base}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `username=${encodeURIComponent(creds.qbittorrent_username ?? "admin")}&password=${encodeURIComponent(creds.qbittorrent_password ?? "")}`,
        signal: AbortSignal.timeout(5000),
      });
      const body = await loginRes.text();
      if (loginRes.ok && body.includes("Ok")) {
        return c.json({ ok: true });
      }
      return c.json({ ok: false, error: body === "Fails." ? "Invalid username or password" : `HTTP ${loginRes.status}` });
    }

    const healthUrl = healthPath(url.replace(/\/$/, ""), apiKey ?? "");
    const headers: Record<string, string> = {};
    if (apiKey && BEARER_AUTH_SERVICES.has(service)) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (apiKey && !QUERY_PARAM_AUTH_SERVICES.has(service)) {
      headers["X-Api-Key"] = apiKey;
    }

    const res = await fetch(healthUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      return c.json({ ok: true });
    }
    return c.json({ ok: false, error: `HTTP ${res.status}` });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

// Auto-detect Plex token from running container's Preferences.xml
settings.post("/detect-plex-token", async (c) => {
  try {
    const containers = await listContainers();
    const plex = containers.find(
      (ct) => ct.image.includes("plex") || ct.name.toLowerCase().includes("plex")
    );
    if (!plex) {
      return c.json({ ok: false, error: "No running Plex container found." });
    }
    const result = await execInContainer(plex.id, [
      "cat",
      "/config/Library/Application Support/Plex Media Server/Preferences.xml",
    ]);
    if (result.exitCode !== 0) {
      return c.json({ ok: false, error: "Could not read Plex Preferences.xml." });
    }
    const match = result.output.match(/PlexOnlineToken="([^"]+)"/);
    if (!match) {
      return c.json({ ok: false, error: "Token not found in Preferences.xml. Has Plex been claimed?" });
    }
    return c.json({ ok: true, token: match[1] });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

// ── Plex OAuth sign-in ────────────────────────────────────────────────────────

const PLEX_CLIENT_ID = "talome-homeserver";
const PLEX_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Plex-Product": "Talome",
  "X-Plex-Version": "1.0.0",
  "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
};

settings.post("/plex-auth/pin", async (c) => {
  try {
    const res = await fetch("https://plex.tv/api/v2/pins?strong=true", {
      method: "POST",
      headers: PLEX_HEADERS,
    });
    if (!res.ok) {
      return c.json({ ok: false, error: `Plex API returned ${res.status}` });
    }
    const data = (await res.json()) as { id: number; code: string };
    return c.json({
      ok: true,
      pinId: data.id,
      authUrl: `https://app.plex.tv/auth#?clientID=${PLEX_CLIENT_ID}&code=${data.code}&forwardUrl=${encodeURIComponent("https://app.plex.tv")}`,
    });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

settings.get("/plex-auth/poll/:pinId", async (c) => {
  try {
    const pinId = c.req.param("pinId");
    const res = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: PLEX_HEADERS,
    });
    if (!res.ok) {
      return c.json({ ok: false, error: `Plex API returned ${res.status}` });
    }
    const data = (await res.json()) as { authToken: string | null };
    if (data.authToken) {
      return c.json({ ok: true, token: data.authToken });
    }
    return c.json({ ok: false, pending: true });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

// ── System Prompt ─────────────────────────────────────────────────────────────

settings.get("/system-prompt", (c) => {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "system_prompt"))
    .get();
  return c.json({
    prompt: row?.value || "",
    default: DEFAULT_SYSTEM_PROMPT,
    isCustom: !!row?.value,
  });
});

settings.post("/system-prompt", async (c) => {
  const parsed = systemPromptSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { prompt } = parsed.data;
  if (!prompt || !prompt.trim()) {
    db.delete(schema.settings)
      .where(eq(schema.settings.key, "system_prompt"))
      .run();
    return c.json({ ok: true, isCustom: false });
  }
  db.insert(schema.settings)
    .values({ key: "system_prompt", value: prompt })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: prompt } })
    .run();
  return c.json({ ok: true, isCustom: true });
});

// ── Tool configuration ────────────────────────────────────────────────────────

settings.get("/tool-config", (c) => {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "disabled_tools"))
      .get();
    const disabled: string[] = row?.value ? JSON.parse(row.value) : [];
    return c.json({ disabled });
  } catch {
    return c.json({ disabled: [] });
  }
});

settings.post("/tool-config", async (c) => {
  const parsed = toolConfigSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { disabled } = parsed.data;
  const value = JSON.stringify(disabled);
  db.insert(schema.settings)
    .values({ key: "disabled_tools", value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
  return c.json({ ok: true, disabled });
});

// ── Tool tiers (dynamic from registry) ────────────────────────────────────────

settings.get("/tool-tiers", (c) => {
  try {
    const tools = getAllToolMeta();
    return c.json({ tools });
  } catch {
    return c.json({ tools: [] });
  }
});

// ── AI Cost Tracking ──────────────────────────────────────────────────────────

settings.get("/ai-cost", async (c) => {
  try {
    const todayCost = getTodayCostUsd();
    const dailyCap = getDailyCapUsd();
    const last7d = getUsageSummary(7);
    const last30d = getUsageSummary(30);

    // Daily breakdown for last 7 days
    const dailyBreakdown: Array<{ date: string; cost: number; calls: number }> = [];
    try {
      const rows = db.all(sql`
        SELECT date(created_at) as day, ROUND(SUM(cost_usd), 4) as cost, COUNT(*) as calls
        FROM ai_usage_log
        WHERE created_at >= date('now', '-7 days')
        GROUP BY day ORDER BY day DESC
      `) as Array<{ day: string; cost: number; calls: number }>;
      for (const row of rows) {
        dailyBreakdown.push({ date: row.day, cost: row.cost, calls: row.calls });
      }
    } catch { /* table may not exist */ }

    // Monthly projection based on 7-day trend
    const projectedMonthly = last7d.totalCostUsd > 0
      ? Math.round((last7d.totalCostUsd / 7) * 30 * 100) / 100
      : 0;

    // Claude Code detection
    const claudeCodeAvailable = await isClaudeCodeAvailable();
    const claudeCodeVersion = getClaudeCodeVersion();

    return c.json({
      today: { cost: Math.round(todayCost * 10000) / 10000, cap: dailyCap, zone: getBudgetZone() },
      last7d: {
        cost: Math.round(last7d.totalCostUsd * 10000) / 10000,
        tokensIn: last7d.totalTokensIn,
        tokensOut: last7d.totalTokensOut,
        byContext: last7d.byContext,
      },
      last30d: {
        cost: Math.round(last30d.totalCostUsd * 10000) / 10000,
        tokensIn: last30d.totalTokensIn,
        tokensOut: last30d.totalTokensOut,
        cacheReadTokens: last30d.totalCacheReadTokens,
        cacheWriteTokens: last30d.totalCacheWriteTokens,
        byContext: last30d.byContext,
      },
      dailyBreakdown,
      projectedMonthly,
      claudeCode: {
        available: claudeCodeAvailable,
        version: claudeCodeVersion,
      },
    });
  } catch (err) {
    return serverError(c, err, { message: "Failed to load AI cost data" });
  }
});

settings.post("/ai-cost/cap", async (c) => {
  const parsed = aiCostCapSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { cap } = parsed.data;
  db.insert(schema.settings)
    .values({ key: "ai_daily_cap_usd", value: String(cap) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: String(cap) } })
    .run();
  return c.json({ ok: true, cap });
});

// ── Setup Link — export / import non-secret config ────────────────────────────

const EXPORTABLE_KEYS = new Set([
  "sonarr_url", "radarr_url", "readarr_url", "prowlarr_url", "qbittorrent_url",
  "overseerr_url", "ollama_url", "disabled_tools", "system_prompt",
]);

settings.get("/export-config", (c) => {
  try {
    const rows = db.select().from(schema.settings).all();
    const exported: Record<string, string> = {};
    for (const row of rows) {
      if (EXPORTABLE_KEYS.has(row.key)) {
        exported[row.key] = row.value; // non-secret keys are stored as plain text
      }
    }
    const code = Buffer.from(JSON.stringify(exported)).toString("base64url");
    return c.json({ code, keyCount: Object.keys(exported).length });
  } catch (err) {
    return serverError(c, err, { message: "Failed to export config" });
  }
});

settings.post("/import-config", async (c) => {
  try {
    const parsed = importConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { code } = parsed.data;
    const decoded = JSON.parse(Buffer.from(code, "base64url").toString("utf-8")) as Record<string, unknown>;
    const applied: string[] = [];
    for (const [key, value] of Object.entries(decoded)) {
      if (!EXPORTABLE_KEYS.has(key)) continue; // strict allowlist
      if (typeof value !== "string" || !value.trim()) continue;
      db.insert(schema.settings)
        .values({ key, value: value as string })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: value as string } })
        .run();
      applied.push(key);
    }
    return c.json({ ok: true, applied });
  } catch (err: any) {
    return c.json({ error: `Invalid setup code: ${err.message}` }, 400);
  }
});

// ── Settings History & Revert ─────────────────────────────────────────────────

settings.get("/history", (c) => {
  try {
    const rows = db
      .select()
      .from(schema.settingsHistory)
      .orderBy(desc(schema.settingsHistory.id))
      .limit(50)
      .all();
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

settings.post("/:key/revert", async (c) => {
  const key = c.req.param("key");
  try {
    const latest = db
      .select()
      .from(schema.settingsHistory)
      .where(eq(schema.settingsHistory.key, key))
      .orderBy(desc(schema.settingsHistory.id))
      .limit(1)
      .get();

    if (!latest) {
      return c.json({ error: `No history for key "${key}"` }, 404);
    }

    const restoreValue = latest.previousValue ?? "";
    const stored = isSecretSettingKey(key) ? encryptSetting(restoreValue) : restoreValue;

    // Atomic: update setting + record history in one transaction
    db.transaction((tx) => {
      tx.insert(schema.settings)
        .values({ key, value: stored })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: stored } })
        .run();

      tx.insert(schema.settingsHistory)
        .values({
          key,
          previousValue: latest.newValue,
          newValue: restoreValue,
          changedBy: "dashboard-revert",
        })
        .run();
    });

    return c.json({
      key,
      restoredValue: isSecretSettingKey(key) ? "****" : restoreValue,
      status: "ok",
    });
  } catch (err) {
    return serverError(c, err, { message: "Failed to revert setting", context: { key } });
  }
});

// ── Alert Thresholds ──────────────────────────────────────────────────────────

const thresholdSchema = z.object({
  cpu: z.object({
    warning: z.number().min(1).max(100),
    critical: z.number().min(1).max(100),
  }).optional(),
  memory: z.object({
    warning: z.number().min(1).max(100),
    critical: z.number().min(1).max(100),
  }).optional(),
});

settings.get("/alert-thresholds", (c) => {
  try {
    const raw = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "alert_thresholds"))
      .get();
    const thresholds = raw?.value ? JSON.parse(raw.value) : {};
    // Disk thresholds are hardcoded (80/90) in monitor.ts — return them for UI display
    return c.json({
      cpu: thresholds.cpu ?? null,
      memory: thresholds.memory ?? null,
      disk: { warning: 80, critical: 90 },
    });
  } catch {
    return c.json({ cpu: null, memory: null, disk: { warning: 80, critical: 90 } });
  }
});

settings.post("/alert-thresholds", async (c) => {
  const parsed = thresholdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const data = parsed.data;

  // Validate warning < critical
  if (data.cpu && data.cpu.warning >= data.cpu.critical) {
    return c.json({ error: "CPU warning must be less than critical" }, 400);
  }
  if (data.memory && data.memory.warning >= data.memory.critical) {
    return c.json({ error: "Memory warning must be less than critical" }, 400);
  }

  const value = JSON.stringify(data);
  db.insert(schema.settings)
    .values({ key: "alert_thresholds", value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();

  return c.json({ ok: true });
});

settings.delete("/alert-thresholds", (c) => {
  db.delete(schema.settings)
    .where(eq(schema.settings.key, "alert_thresholds"))
    .run();
  return c.json({ ok: true });
});

export { settings };
