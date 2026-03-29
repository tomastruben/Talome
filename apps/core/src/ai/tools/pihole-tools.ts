import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { isSecretSettingKey, decryptSetting } from "../../utils/crypto.js";

function getSetting(key: string): string | undefined {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (!row?.value) return undefined;
    return isSecretSettingKey(key) ? decryptSetting(row.value) : row.value;
  } catch {
    return undefined;
  }
}

function getPiholeConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = getSetting("pihole_url");
  const apiKey = getSetting("pihole_api_key");
  if (!baseUrl) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey ?? "" };
}

async function piholeFetch(params: Record<string, string>): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getPiholeConfig();
  if (!config) {
    return {
      success: false,
      error: "Pi-hole is not configured. Add pihole_url in Settings.",
      hint: "Get the API token from Pi-hole admin panel → Settings → API/Web interface → Show API token.",
    };
  }
  const qs = new URLSearchParams({ ...params, auth: config.apiKey }).toString();
  try {
    const res = await fetch(`${config.baseUrl}/admin/api.php?${qs}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { success: false, error: `Pi-hole API error ${res.status}` };
    }
    const data = await res.json();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── pihole_get_stats ──────────────────────────────────────────────────────────

export const piholeGetStatsTool = tool({
  description: "Get Pi-hole statistics: total queries, blocked queries, block percentage, number of blocklist entries, and top blocked domains.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await piholeFetch({ summaryRaw: "" });
    if (!result.success) return result;
    return { success: true, stats: result.data };
  },
});

// ── pihole_enable ─────────────────────────────────────────────────────────────

export const piholeEnableTool = tool({
  description: "Enable Pi-hole blocking (resume DNS-level ad blocking).",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await piholeFetch({ enable: "" });
    if (!result.success) return result;
    return { success: true, message: "Pi-hole blocking enabled.", status: result.data };
  },
});

// ── pihole_disable ────────────────────────────────────────────────────────────

export const piholeDisableTool = tool({
  description: "Temporarily disable Pi-hole blocking. Specify a duration in seconds (0 = permanently until re-enabled).",
  inputSchema: z.object({
    seconds: z.number().default(300).describe("Number of seconds to disable (0 = permanent until manually re-enabled)"),
  }),
  execute: async ({ seconds }) => {
    const params = seconds > 0 ? { disable: String(seconds) } : { disable: "" };
    const result = await piholeFetch(params);
    if (!result.success) return result;
    const msg = seconds > 0 ? `Pi-hole disabled for ${seconds} seconds.` : "Pi-hole disabled indefinitely.";
    return { success: true, message: msg, status: result.data };
  },
});

// ── pihole_whitelist ──────────────────────────────────────────────────────────

export const piholeWhitelistTool = tool({
  description: "Add a domain to Pi-hole's whitelist so it is never blocked.",
  inputSchema: z.object({
    domain: z.string().describe("Domain to whitelist, e.g. 'example.com'"),
  }),
  execute: async ({ domain }) => {
    const result = await piholeFetch({ list: "white", add: domain });
    if (!result.success) return result;
    return { success: true, message: `'${domain}' added to Pi-hole whitelist.` };
  },
});

// ── pihole_blacklist ──────────────────────────────────────────────────────────

export const piholeBlacklistTool = tool({
  description: "Add a domain to Pi-hole's blacklist to block it.",
  inputSchema: z.object({
    domain: z.string().describe("Domain to blacklist, e.g. 'ads.example.com'"),
  }),
  execute: async ({ domain }) => {
    const result = await piholeFetch({ list: "black", add: domain });
    if (!result.success) return result;
    return { success: true, message: `'${domain}' added to Pi-hole blacklist.` };
  },
});
