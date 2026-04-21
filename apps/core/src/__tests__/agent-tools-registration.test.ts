import { describe, it, expect, vi } from "vitest";

// Mock DB — agent.ts and all tools it imports call getSetting() via db
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null),
        }),
      }),
    }),
  },
  schema: {
    settings: { key: "key" },
    installedApps: { appId: "app_id" },
    mcpTokens: { tokenHash: "token_hash", id: "id", lastUsedAt: "last_used_at" },
    memories: {},
  },
}));

vi.mock("../db/audit.js", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../db/memories.js", () => ({
  getTopMemories: vi.fn().mockResolvedValue([]),
}));

import { getAllRegisteredTools } from "../ai/tool-registry.js";

// Import agent.js to trigger domain registrations
import "../ai/agent.js";

// ── Tool registration completeness test ───────────────────────────────────────
// Uses getAllRegisteredTools() because the test verifies registration, not active filtering.
describe("allTools registration", () => {
  const toolNames = Object.keys(getAllRegisteredTools());

  it("has more than 70 tools registered", () => {
    expect(toolNames.length).toBeGreaterThan(70);
  });

  // Phase 17B tools
  it.each([
    "get_app_config",
    "set_app_env",
    "change_port_mapping",
    "add_volume_mount",
    "set_resource_limits",
    "upgrade_app_image",
    "diagnose_app",
  ])("has Phase 17B tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 Arr tools
  it.each([
    "arr_get_status",
    "arr_list_root_folders",
    "arr_add_root_folder",
    "arr_list_download_clients",
    "arr_add_download_client",
    "arr_test_download_client",
    "arr_list_indexers",
    "arr_sync_indexers_from_prowlarr",
    "arr_list_quality_profiles",
    "arr_apply_quality_profile",
    "arr_get_wanted_missing",
    "arr_get_wanted_cutoff",
    "arr_search_releases",
    "arr_grab_release",
    "arr_get_queue_details",
    "arr_queue_action",
    "arr_cleanup_dry_run",
    "arr_set_naming_convention",
  ])("has Phase 18 Arr tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 qBittorrent tools
  it.each([
    "qbt_get_version",
    "qbt_get_preferences",
    "qbt_set_preferences",
    "qbt_set_download_path",
    "qbt_set_speed_limits",
    "qbt_list_torrents",
  ])("has Phase 18 qBittorrent tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 Jellyfin tools
  it.each([
    "jellyfin_get_status",
    "jellyfin_list_libraries",
    "jellyfin_add_library",
    "jellyfin_scan_library",
    "jellyfin_get_stats",
    "jellyfin_create_api_key",
  ])("has Phase 18 Jellyfin tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 Overseerr tools
  it.each([
    "overseerr_get_status",
    "overseerr_configure_jellyfin",
    "overseerr_configure_sonarr",
    "overseerr_configure_radarr",
    "overseerr_list_requests",
    "overseerr_approve_request",
  ])("has Phase 18 Overseerr tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 Home Assistant tools
  it.each([
    "hass_get_status",
    "hass_list_entities",
    "hass_call_service",
    "hass_get_history",
    "hass_create_automation",
  ])("has Phase 18 Home Assistant tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 Pi-hole tools
  it.each([
    "pihole_get_stats",
    "pihole_enable",
    "pihole_disable",
    "pihole_whitelist",
    "pihole_blacklist",
  ])("has Phase 18 Pi-hole tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Phase 18 Vaultwarden tools
  it.each([
    "vaultwarden_get_status",
    "vaultwarden_invite_user",
    "vaultwarden_list_users",
    "vaultwarden_toggle_signups",
  ])("has Phase 18 Vaultwarden tool: %s", (toolName) => {
    expect(toolNames).toContain(toolName);
  });

  // Universal config file tools
  it.each(["read_app_config_file", "write_app_config_file"])(
    "has universal config tool: %s",
    (toolName) => {
      expect(toolNames).toContain(toolName);
    }
  );

  // App blueprint tool
  it("has design_app_blueprint tool", () => {
    expect(toolNames).toContain("design_app_blueprint");
  });

  it("every tool has an execute function", () => {
    for (const [name, toolDef] of Object.entries(getAllRegisteredTools())) {
      expect(typeof (toolDef as Record<string, unknown>).execute, `${name}.execute`).toBe("function");
    }
  });
});
