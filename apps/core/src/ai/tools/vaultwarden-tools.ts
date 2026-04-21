import { tool } from "ai";
import { z } from "zod";
import { getSetting } from "../../utils/settings.js";

interface VaultwardenConfig {
  baseUrl: string;
  adminToken: string;
}

function getVwConfig(): VaultwardenConfig | null {
  const baseUrl = getSetting("vaultwarden_url");
  const adminToken = getSetting("vaultwarden_admin_token");
  if (!baseUrl || !adminToken) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), adminToken };
}

async function vwFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getVwConfig();
  if (!config) {
    return {
      success: false,
      error: "Vaultwarden is not configured. Add vaultwarden_url and vaultwarden_admin_token in Settings.",
      hint: "The admin token is the ADMIN_TOKEN environment variable you set when installing Vaultwarden.",
    };
  }
  try {
    // Vaultwarden admin API uses a cookie or Basic auth with the admin token
    const isAdmin = path.startsWith("/admin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> ?? {}),
    };
    if (isAdmin) {
      headers["Authorization"] = `Bearer ${config.adminToken}`;
    }

    const res = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Vaultwarden API error ${res.status}: ${text}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── vaultwarden_get_status ────────────────────────────────────────────────────

export const vaultwardenGetStatusTool = tool({
  description: "Check Vaultwarden health and get server status.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await vwFetch("/api/alive");
    if (!result.success) return result;
    return { success: true, message: "Vaultwarden is running.", status: result.data };
  },
});

// ── vaultwarden_invite_user ───────────────────────────────────────────────────

export const vaultwardenInviteUserTool = tool({
  description: "Invite a user to join Vaultwarden by email. They will receive an invite link.",
  inputSchema: z.object({
    email: z.string().email().describe("Email address to invite"),
  }),
  execute: async ({ email }) => {
    const result = await vwFetch("/admin/invite", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    if (!result.success) return result;
    return { success: true, message: `Invite sent to ${email}.` };
  },
});

// ── vaultwarden_list_users ────────────────────────────────────────────────────

export const vaultwardenListUsersTool = tool({
  description: "List all users registered in Vaultwarden via the admin API.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await vwFetch("/admin/users");
    if (!result.success) return result;
    const users = (result.data as Array<Record<string, unknown>>).map((u) => ({
      id: u._id ?? u.Id,
      email: u.Email,
      name: u.Name,
      enabled: u.Enabled,
      emailVerified: u.EmailVerified,
      createdAt: u.CreatedAt,
    }));
    return { success: true, count: users.length, users };
  },
});

// ── vaultwarden_toggle_signups ────────────────────────────────────────────────

export const vaultwardenToggleSignupsTool = tool({
  description: "Enable or disable new user signups on Vaultwarden. Disable after initial setup to prevent unauthorised registrations.",
  inputSchema: z.object({
    allow: z.boolean().describe("true to allow signups, false to disable them"),
  }),
  execute: async ({ allow }) => {
    const result = await vwFetch("/admin/config", {
      method: "POST",
      body: JSON.stringify({ signups_allowed: allow }),
    });
    if (!result.success) return result;
    return { success: true, message: `Vaultwarden signups ${allow ? "enabled" : "disabled"}.` };
  },
});
