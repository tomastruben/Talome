import { describe, it, expect } from "vitest";
import {
  FULL_ACCESS_SCOPES,
  READ_ONLY_SCOPES,
  checkCallGrant,
  checkToolGrant,
  extractTargets,
  parseTokenScopes,
  targetMatchesApp,
  type TokenScopes,
} from "../approval/grants.js";

const meta = (name: string, tier: "read" | "modify" | "destructive", domain = "core") => ({ name, tier, domain });

describe("parseTokenScopes", () => {
  it("falls back to read-only for missing or malformed scopes", () => {
    expect(parseTokenScopes(null)).toEqual(READ_ONLY_SCOPES);
    expect(parseTokenScopes("not json")).toEqual(READ_ONLY_SCOPES);
    expect(parseTokenScopes(JSON.stringify({ maxTier: "root", domains: "all", apps: "all" }))).toEqual(READ_ONLY_SCOPES);
    expect(parseTokenScopes(JSON.stringify(FULL_ACCESS_SCOPES))).toEqual(FULL_ACCESS_SCOPES);
  });
});

describe("checkToolGrant", () => {
  it("enforces tier ceilings", () => {
    expect(checkToolGrant(READ_ONLY_SCOPES, meta("list_apps", "read")).ok).toBe(true);
    const denied = checkToolGrant(READ_ONLY_SCOPES, meta("restart_app", "modify"));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.message).toContain("'modify' tier");
      expect(denied.hint).toContain("Settings -> AI agents");
    }
  });

  it("enforces domains, allow-list and deny-list (deny wins)", () => {
    const scopes: TokenScopes = { maxTier: "destructive", domains: ["core"], apps: "all", tools: ["restart_app", "list_apps"], deniedTools: ["list_apps"] };
    expect(checkToolGrant(scopes, meta("restart_app", "modify")).ok).toBe(true);
    expect(checkToolGrant(scopes, meta("list_apps", "read")).ok).toBe(false);
    expect(checkToolGrant(scopes, meta("stop_app", "modify")).ok).toBe(false);
    expect(checkToolGrant({ ...scopes, tools: undefined, deniedTools: undefined }, meta("jellyfin_scan_library", "modify", "jellyfin")).ok).toBe(false);
  });
});

describe("app / resource grants", () => {
  const onlyJellyfin: TokenScopes = { maxTier: "destructive", domains: "all", apps: ["jellyfin"] };

  it("extracts targets from known argument names", () => {
    expect(extractTargets("restart_app", "core", { appId: "sonarr" })).toEqual(["sonarr"]);
    expect(extractTargets("stop_container", "core", { containerId: "sonarr" })).toEqual(["sonarr"]);
    expect(extractTargets("wire_apps", "core", { sourceAppId: "a", targetAppId: "b" })).toEqual(["a", "b"]);
    expect(extractTargets("bulk_app_action", "core", { appIds: ["a", "b"], action: "stop" })).toEqual(["a", "b"]);
    expect(extractTargets("arr_run_command", "arr", { app: "radarr" })).toEqual(["radarr"]);
    expect(extractTargets("prowlarr_manage_indexers", "arr", { action: "list" })).toEqual(["prowlarr"]);
    expect(extractTargets("qbt_set_speed_limits", "qbittorrent", {})).toEqual(["qbittorrent"]);
    // `name` is not a generic target key (network / automation names)
    expect(extractTargets("remove_network", "core", { name: "jellyfin" })).toBeNull();
    expect(extractTargets("prune_resources", "core", { targets: ["images"] })).toBeNull();
    expect(extractTargets("restart_app", "core", { appId: 42 })).toBeNull();
  });

  it("matches app ids and their stack containers, never lookalikes", () => {
    expect(targetMatchesApp("jellyfin", "jellyfin")).toBe(true);
    expect(targetMatchesApp("/jellyfin-db", "jellyfin")).toBe(true);
    expect(targetMatchesApp("jellyfin_worker", "jellyfin")).toBe(true);
    expect(targetMatchesApp("jellyfinx", "jellyfin")).toBe(false);
    expect(targetMatchesApp("my-jellyfin", "jellyfin")).toBe(false);
    expect(targetMatchesApp("3f2a9c1e5b7d", "jellyfin")).toBe(false);
    expect(targetMatchesApp("home-assistant", "homeassistant")).toBe(true);
  });

  it("allows own-app calls and rejects cross-app calls", () => {
    expect(checkCallGrant(onlyJellyfin, meta("restart_app", "modify"), { appId: "jellyfin" }).ok).toBe(true);
    expect(checkCallGrant(onlyJellyfin, meta("restart_app", "modify"), { appId: "sonarr" }).ok).toBe(false);
    expect(checkCallGrant(onlyJellyfin, meta("wire_apps", "modify"), { sourceAppId: "jellyfin", targetAppId: "sonarr" }).ok).toBe(false);
    expect(checkCallGrant(onlyJellyfin, meta("jellyfin_scan_library", "modify", "jellyfin"), {}).ok).toBe(true);
    expect(checkCallGrant(onlyJellyfin, meta("plex_mark_watched", "modify", "plex"), { ratingKey: "1" }).ok).toBe(false);
  });

  it("denies modify/destructive calls whose target cannot be determined; allows such reads", () => {
    expect(checkCallGrant(onlyJellyfin, meta("prune_resources", "destructive"), { targets: ["images"] }).ok).toBe(false);
    expect(checkCallGrant(onlyJellyfin, meta("create_automation", "modify"), { name: "jellyfin" }).ok).toBe(false);
    expect(checkCallGrant(onlyJellyfin, meta("list_containers", "read"), {}).ok).toBe(true);
    // but a read that names another app is still refused
    expect(checkCallGrant(onlyJellyfin, meta("get_container_logs", "read"), { containerId: "sonarr" }).ok).toBe(false);
  });
});
