/**
 * Shared fixtures for trust-*.test.ts: a per-file SQLite DB and a small set of
 * fake tools registered in the real tool registry (no docker, no network).
 *
 * Usage (DATABASE_PATH must be set before db/index.js is imported):
 *
 *   vi.hoisted(() => { process.env.DATABASE_PATH = tempDbPath("name"); });
 */

import { tool } from "ai";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDomain } from "../../ai/tool-registry.js";

export function tempDbPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `talome-trust-${label}-`)), "talome.db");
}

export const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

function record(name: string, args: Record<string, unknown>) {
  toolCalls.push({ tool: name, args });
}

export const fakeTools = {
  list_things: tool({
    description: "List things (read).",
    inputSchema: z.object({}),
    execute: async () => {
      record("list_things", {});
      return { items: ["a", "b"] };
    },
  }),
  get_app_config: tool({
    description: "Read an app's config (read).",
    inputSchema: z.object({ appId: z.string() }),
    execute: async ({ appId }) => {
      record("get_app_config", { appId });
      return { appId, config: {} };
    },
  }),
  restart_app: tool({
    description: "Restart an app (modify).",
    inputSchema: z.object({ appId: z.string() }),
    execute: async ({ appId }) => {
      record("restart_app", { appId });
      return { success: true, appId };
    },
  }),
  create_automation: tool({
    description: "Create an automation (modify, no app target).",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      record("create_automation", { name });
      return { success: true, name };
    },
  }),
  uninstall_app: tool({
    description: "Uninstall an app (destructive).",
    inputSchema: z.object({ appId: z.string(), confirmed: z.boolean().optional() }),
    execute: async ({ appId, confirmed }) => {
      record("uninstall_app", { appId, confirmed });
      return { success: true, appId };
    },
  }),
  set_setting: tool({
    description: "Set a setting (modify; protected keys escalate).",
    inputSchema: z.object({ key: z.string(), value: z.string() }),
    execute: async ({ key, value }) => {
      record("set_setting", { key, value });
      return { key, saved: true };
    },
  }),
  failing_tool: tool({
    description: "Returns {error} without throwing.",
    inputSchema: z.object({}),
    execute: async () => ({ error: "boom: upstream refused" }),
  }),
  soft_failing_tool: tool({
    description: "Returns {success:false}.",
    inputSchema: z.object({}),
    execute: async () => ({ success: false, message: "nothing to do" }),
  }),
  throwing_tool: tool({
    description: "Throws.",
    inputSchema: z.object({}),
    execute: async (): Promise<unknown> => {
      throw new Error("exploded");
    },
  }),
  send_payload: tool({
    description: "Accepts free-form payload (modify).",
    inputSchema: z.object({ appId: z.string(), body: z.string(), password: z.string().optional() }),
    execute: async ({ appId }) => ({ success: true, appId }),
  }),
};

export const fakeJellyfinTools = {
  jellyfin_scan_library: tool({
    description: "Scan a Jellyfin library (modify).",
    inputSchema: z.object({ libraryId: z.string().optional() }),
    execute: async () => {
      record("jellyfin_scan_library", {});
      return { success: true };
    },
  }),
};

let registered = false;

/** Register the fake domains once per test file. */
export function registerFakeDomains(): void {
  if (registered) return;
  registered = true;
  registerDomain({
    name: "core",
    settingsKeys: [],
    tools: fakeTools,
    tiers: {
      list_things: "read",
      get_app_config: "read",
      restart_app: "modify",
      create_automation: "modify",
      uninstall_app: "destructive",
      set_setting: "modify",
      failing_tool: "read",
      soft_failing_tool: "modify",
      throwing_tool: "read",
      send_payload: "modify",
    },
  });
  registerDomain({
    name: "jellyfin",
    settingsKeys: ["jellyfin_url"],
    tools: fakeJellyfinTools,
    tiers: { jellyfin_scan_library: "modify" },
  });
}
