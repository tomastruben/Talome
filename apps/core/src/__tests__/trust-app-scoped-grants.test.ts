/**
 * App-limited grants must hold for every argument of a call, not just the app
 * id: a token limited to "jellyfin" must not bind docker.sock or "/" into it,
 * exec into it, publish another app through the proxy, or join another app's
 * network.
 */
import { describe, it, expect } from "vitest";
import { checkCallGrant, checkToolGrant, FULL_ACCESS_SCOPES, type TokenScopes, type ToolTier } from "../approval/grants.js";

const jellyfinOnly: TokenScopes = { maxTier: "destructive", domains: "all", apps: ["jellyfin"] };
const jellyfinModify: TokenScopes = { maxTier: "modify", domains: "all", apps: ["jellyfin"] };

function call(scopes: TokenScopes, name: string, args: Record<string, unknown>, tier: ToolTier = "modify", domain = "core") {
  return checkCallGrant(scopes, { name, tier, domain }, args, ["jellyfin", "vaultwarden"]);
}

describe("app-limited grants and host reach", () => {
  it("never binds a host path into the app", () => {
    for (const hostPath of ["/var/run/docker.sock", "/", "/home/me/.ssh", "/srv/jellyfin/media"]) {
      const d = call(jellyfinModify, "add_volume_mount", { appId: "jellyfin", hostPath, containerPath: "/x" });
      expect(d.ok, hostPath).toBe(false);
    }
    // Hidden from an app-limited token's tool list too.
    expect(checkToolGrant(jellyfinModify, { name: "add_volume_mount", tier: "modify", domain: "core" }).ok).toBe(false);
  });

  it("never execs into a container", () => {
    const d = call(jellyfinModify, "exec_container", { containerId: "jellyfin", command: ["curl", "--unix-socket", "/var/run/docker.sock", "http://x/containers/json"] });
    expect(d.ok).toBe(false);
    expect(checkToolGrant(jellyfinOnly, { name: "exec_container", tier: "modify", domain: "core" }).ok).toBe(false);
  });

  it("install_app may not carry host paths or wire other apps", () => {
    expect(call(jellyfinModify, "install_app", { appId: "jellyfin", storeId: "s" }).ok).toBe(true);
    expect(call(jellyfinModify, "install_app", { appId: "jellyfin", storeId: "s", env: { TZ: "Europe/Prague" } }).ok).toBe(true);
    for (const extra of [
      { volumeMounts: { media: "/" } },
      { volumeMounts: { config: "/var/run/docker.sock" } },
      { umbrel: { folders: { photos: "/home/me" } } },
      { umbrel: { dataRoot: "/var" } },
      { env: { APP_DATA_DIR: "/home/me/.ssh" } },
      { env: { APP_DATA_DIR: "../../../" } },
      { env: { MEDIA: "~/" } },
      { env: { DATA: "${HOME}" } },
      { umbrel: { dependencies: { passwords: "vaultwarden" } } },
    ]) {
      expect(call(jellyfinModify, "install_app", { appId: "jellyfin", storeId: "s", ...extra }).ok, JSON.stringify(extra)).toBe(false);
    }
    expect(call(jellyfinModify, "install_app", { appId: "jellyfin", storeId: "s", umbrel: { dependencies: { media: "jellyfin" } } }).ok).toBe(true);
  });

  it("a proxy route may only publish the allowed app", () => {
    const route = (upstream: string, appId: string | undefined = "jellyfin") =>
      call(jellyfinModify, "proxy_add_route", { domain: "x.example", upstream, ...(appId ? { appId } : {}) }, "modify", "proxy");
    expect(route("jellyfin:8096").ok).toBe(true);
    expect(route("http://jellyfin:8096/web").ok).toBe(true);
    expect(route("jellyfin-web:80").ok).toBe(true);
    for (const upstream of ["vaultwarden:80", "http://vaultwarden", "localhost:8096", "127.0.0.1:2375", "http://192.168.1.2:80", "jellyfin.evil.example:80", "http://jellyfin@vaultwarden:80", "[::1]:80"]) {
      expect(route(upstream).ok, upstream).toBe(false);
    }
    expect(route("vaultwarden:80", undefined).ok).toBe(false);
  });

  it("joining a network counts the network as a target", () => {
    const net = (network: string) => call(jellyfinModify, "connect_container_to_network", { container: "jellyfin", network });
    expect(net("jellyfin_default").ok).toBe(true);
    expect(net("vaultwarden_default").ok).toBe(false);
    expect(net("host").ok).toBe(false);
    expect(call(jellyfinModify, "disconnect_container", { container: "jellyfin", network: "vaultwarden_default" }).ok).toBe(false);
  });

  it("restore_app may not read a backup from an arbitrary path", () => {
    expect(call(jellyfinOnly, "restore_app", { appId: "jellyfin", backupId: "b1" }, "destructive").ok).toBe(true);
    expect(call(jellyfinOnly, "restore_app", { appId: "jellyfin", backupFile: "/home/me/.talome/backups/vaultwarden/x.tar.gz" }, "destructive").ok).toBe(false);
  });

  it("does not change unrestricted tokens", () => {
    expect(checkCallGrant(FULL_ACCESS_SCOPES, { name: "add_volume_mount", tier: "modify", domain: "core" }, { appId: "jellyfin", hostPath: "/mnt/media", containerPath: "/media" }).ok).toBe(true);
    expect(checkToolGrant(FULL_ACCESS_SCOPES, { name: "exec_container", tier: "modify", domain: "core" }).ok).toBe(true);
    expect(checkCallGrant(FULL_ACCESS_SCOPES, { name: "proxy_add_route", tier: "modify", domain: "proxy" }, { domain: "x", upstream: "localhost:1" }).ok).toBe(true);
  });
});
