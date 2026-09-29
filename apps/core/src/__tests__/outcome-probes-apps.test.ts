import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-outcome-probes-apps-${process.pid}.db`;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

// Belt and braces: any accidental real network call fails loudly.
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("real network disabled in tests"); }));

import { verifyApp, type VerificationResult } from "../verification/index.js";
import {
  SECRETS,
  URLS,
  allSecretValues,
  healthyMediaRoutes,
  healthyMounts,
  jsonResponse,
  makeDeps,
  mediaSettings,
  plexOnlyOverseerrRoutes,
  textResponse,
  type RouteHandler,
} from "./outcome-probes-fixtures.js";

async function run(
  appId: string,
  opts: { settings?: Record<string, string>; routes?: Record<string, RouteHandler | "hang">; mounts?: Parameters<typeof makeDeps>[0]["mounts"]; includeActive?: boolean; timeoutMs?: number } = {},
) {
  const { deps, calls } = makeDeps({
    settings: opts.settings ?? mediaSettings(),
    routes: opts.routes ?? healthyMediaRoutes(),
    mounts: opts.mounts === undefined ? healthyMounts() : opts.mounts,
  });
  const out = await verifyApp(appId, { deps, persist: false, includeActive: opts.includeActive, timeoutMs: opts.timeoutMs });
  if (!out.ok) throw new Error(out.error);
  return { result: out.result, calls };
}

function check(result: VerificationResult, id: string) {
  const c = result.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing: ${result.checks.map((x) => x.id).join(", ")}`);
  return c;
}

function expectNoSecrets(result: VerificationResult) {
  const json = JSON.stringify(result);
  for (const s of allSecretValues()) expect(json).not.toContain(s);
}

const hangAll = (routes: Record<string, RouteHandler | "hang">) =>
  Object.fromEntries(Object.keys(routes).map((k) => [k, "hang" as const]));

// ── Timeout path for every probe ───────────────────────────────────────────

describe("every app probe times out cleanly", () => {
  const settings = {
    ...mediaSettings(),
    immich_url: URLS.immich,
    immich_api_key: SECRETS.immich,
    audiobookshelf_url: URLS.abs,
    audiobookshelf_api_key: SECRETS.abs,
    homeassistant_url: URLS.hass,
    homeassistant_token: SECRETS.hass,
    readarr_url: "http://readarr:8787",
    readarr_api_key: "READARR-KEY-1",
    jellyseerr_url: "http://jellyseerr:5055",
    jellyseerr_api_key: "JELLYSEERR-KEY-1",
  };
  const catchAllHang = createHangingRoutes();

  it.each([
    "jellyfin", "sonarr", "radarr", "readarr", "prowlarr", "qbittorrent",
    "immich", "audiobookshelf", "homeassistant", "overseerr", "jellyseerr",
  ])("%s → first check times out and the app is failed", async (appId) => {
    const { result } = await run(appId, { settings, routes: catchAllHang, timeoutMs: 40 });
    expect(result.checks[0].status).toBe("timeout");
    expect(result.checks[0].critical).toBe(true);
    expect(result.status).toBe("failed");
    expectNoSecrets(result);
  });
});

function createHangingRoutes(): Record<string, "hang"> {
  const hosts = ["http://sonarr:8989", "http://radarr:7878", "http://readarr:8787", "http://prowlarr:9696", "http://qbittorrent:8080", "http://jellyfin:8096",
    "http://immich:2283", "http://audiobookshelf:13378", "http://homeassistant:8123", "http://overseerr:5055", "http://jellyseerr:5055"];
  const paths = ["/api/v3/system/status", "/api/v1/system/status", "/api/v2/auth/login", "/System/Info", "/api/server/ping", "/api/me", "/api/", "/api/v1/status"];
  const routes: Record<string, "hang"> = {};
  for (const h of hosts) for (const p of paths) for (const m of ["GET", "POST"]) routes[`${m} ${h}${p}`] = "hang";
  return routes;
}

// ── Not configured ─────────────────────────────────────────────────────────

describe("unconfigured apps", () => {
  it("returns unknown with remediation, and makes no network calls", async () => {
    const { result, calls } = await run("sonarr", { settings: {} });
    expect(result.status).toBe("unknown");
    expect(check(result, "api").status).toBe("skip");
    expect(check(result, "api").remediation).toMatch(/Settings/);
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown app ids", async () => {
    const out = await verifyApp("not-an-app", { persist: false });
    expect(out.ok).toBe(false);
  });
});

// ── Sonarr / Radarr ────────────────────────────────────────────────────────

describe("sonarr/radarr probe", () => {
  it("verifies a healthy Sonarr and never sends the key anywhere but Sonarr", async () => {
    const { result, calls } = await run("sonarr");
    expect(result.status).toBe("verified");
    expect(check(result, "api").evidence).toContain("4.0.14");
    expect(check(result, "root-folders").evidence).toContain("/tv");
    expect(check(result, "download-client").status).toBe("pass");
    expect(check(result, "indexers").status).toBe("pass");
    expect(check(result, "download-client-test").status).toBe("skip"); // active probe off by default
    expect(calls.some((c) => c.url.includes("/downloadclient/test"))).toBe(false);
    for (const c of calls) {
      if (c.headers["x-api-key"]) expect(c.url.startsWith(URLS.sonarr)).toBe(true);
    }
    expectNoSecrets(result);
  });

  it("runs the download-client test only when active probes are requested", async () => {
    const { result, calls } = await run("radarr", { includeActive: true });
    expect(check(result, "download-client-test").status).toBe("pass");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/v3/downloadclient/test"))).toBe(true);
  });

  it("fails with a precise remediation when the API key is rejected", async () => {
    const routes = { ...healthyMediaRoutes(), [`GET ${URLS.sonarr}/api/v3/system/status`]: jsonResponse({ error: "Unauthorized" }, 401) };
    const { result } = await run("sonarr", { routes });
    expect(result.status).toBe("failed");
    expect(check(result, "api").status).toBe("fail");
    expect(check(result, "api").remediation).toContain("sonarr_api_key");
    expect(check(result, "root-folders").status).toBe("skip");
  });

  it("fails when there is no root folder, an inaccessible one, or no indexers", async () => {
    const noRoot = await run("sonarr", { routes: { ...healthyMediaRoutes(), [`GET ${URLS.sonarr}/api/v3/rootfolder`]: jsonResponse([]) } });
    expect(check(noRoot.result, "root-folders").status).toBe("fail");
    // An *arr that can't import anything is broken, not merely degraded.
    expect(noRoot.result.status).toBe("failed");

    const inaccessible = await run("sonarr", { routes: { ...healthyMediaRoutes(), [`GET ${URLS.sonarr}/api/v3/rootfolder`]: jsonResponse([{ path: "/tv", accessible: false }]) } });
    expect(check(inaccessible.result, "root-folders").evidence).toContain("cannot access /tv");

    const noIdx = await run("sonarr", { routes: { ...healthyMediaRoutes(), [`GET ${URLS.sonarr}/api/v3/indexer`]: jsonResponse([]) } });
    expect(check(noIdx.result, "indexers").status).toBe("fail");
    expect(check(noIdx.result, "indexers").remediation).toContain("Prowlarr");
  });

  it("fails the download-client check when the *arr reports it unreachable, without leaking the password", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.sonarr}/api/v3/health`]: jsonResponse([
        { source: "DownloadClientCheck", type: "error", message: `Unable to communicate with qBittorrent (password=${SECRETS.qbt})` },
      ]),
    };
    const { result } = await run("sonarr", { routes });
    expect(check(result, "download-client").status).toBe("fail");
    expect(check(result, "download-client").evidence).toContain("Unable to communicate");
    expectNoSecrets(result);
  });

  it("redacts the API key even when the app echoes it in an error body", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.sonarr}/api/v3/rootfolder`]: jsonResponse({ message: `boom for key ${SECRETS.sonarr}` }, 500),
    };
    const { result } = await run("sonarr", { routes });
    expect(check(result, "root-folders").status).toBe("fail");
    expect(check(result, "root-folders").evidence).toContain("[redacted]");
    expectNoSecrets(result);
  });
});

// ── Prowlarr ────────────────────────────────────────────────────────────────

describe("prowlarr probe", () => {
  it("verifies indexers and app sync", async () => {
    const { result } = await run("prowlarr");
    expect(result.status).toBe("verified");
    expect(check(result, "app-sync").evidence).toContain("Sonarr");
  });

  it("warns when a configured *arr is not synced and fails with no apps", async () => {
    const partial = await run("prowlarr", {
      routes: { ...healthyMediaRoutes(), [`GET ${URLS.prowlarr}/api/v1/applications`]: jsonResponse([{ name: "Sonarr", implementation: "Sonarr", syncLevel: "fullSync" }]) },
    });
    expect(check(partial.result, "app-sync").status).toBe("warn");
    expect(check(partial.result, "app-sync").evidence).toContain("Radarr");

    const none = await run("prowlarr", { routes: { ...healthyMediaRoutes(), [`GET ${URLS.prowlarr}/api/v1/applications`]: jsonResponse([]) } });
    expect(check(none.result, "app-sync").status).toBe("fail");

    const noIdx = await run("prowlarr", { routes: { ...healthyMediaRoutes(), [`GET ${URLS.prowlarr}/api/v1/indexer`]: jsonResponse([]) } });
    expect(check(noIdx.result, "indexers").status).toBe("fail");
  });
});

// ── qBittorrent ────────────────────────────────────────────────────────────

describe("qbittorrent probe", () => {
  it("logs in, reads the save path and proves the *arr apps see it", async () => {
    const { result, calls } = await run("qbittorrent");
    expect(result.status).toBe("verified");
    expect(check(result, "login").evidence).toContain("v5.0.4");
    expect(check(result, "save-path").evidence).toContain("/downloads");
    expect(check(result, "arr-save-path").evidence).toContain("/srv/downloads");
    // Session cookie is reused, never shown.
    expect(calls.filter((c) => c.url.endsWith("/api/v2/auth/login"))).toHaveLength(1);
    expect(calls.some((c) => c.headers.cookie === `SID=${SECRETS.sid}`)).toBe(true);
    expectNoSecrets(result);
  });

  it("fails when the password is wrong", async () => {
    const { result } = await run("qbittorrent", { routes: { ...healthyMediaRoutes(), [`POST ${URLS.qbt}/api/v2/auth/login`]: textResponse("Fails.") } });
    expect(result.status).toBe("failed");
    expect(check(result, "login").remediation).toContain("qbittorrent_password");
  });

  it("flags an *arr that stores downloads in a different host folder", async () => {
    const mounts = { ...healthyMounts(), radarr: [{ source: "/srv/media/movies", destination: "/movies" }, { source: "/srv/other-downloads", destination: "/downloads" }] };
    const { result } = await run("qbittorrent", { mounts });
    const c = check(result, "arr-save-path");
    expect(c.status).toBe("fail");
    expect(c.evidence).toContain("Radarr");
    expect(c.evidence).toContain("different directories");
    expect(result.status).toBe("degraded");
  });

  it("fails when the *arr cannot see qBittorrent's save path at all", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.qbt}/api/v2/app/preferences`]: jsonResponse({ save_path: "/data/torrents" }),
    };
    const { result } = await run("qbittorrent", { routes, mounts: null });
    const c = check(result, "arr-save-path");
    expect(c.status).toBe("fail");
    expect(c.evidence).toContain("/data/torrents");
    expect(c.remediation).toMatch(/Remote Path Mapping/);
  });

  it("accepts a remote path mapping in the *arr", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.qbt}/api/v2/app/preferences`]: jsonResponse({ save_path: "/data/torrents" }),
      [`GET ${URLS.sonarr}/api/v3/remotepathmapping`]: jsonResponse([{ host: "qbittorrent", remotePath: "/data/torrents/", localPath: "/downloads/" }]),
      [`GET ${URLS.radarr}/api/v3/remotepathmapping`]: jsonResponse([{ host: "qbittorrent", remotePath: "/data/torrents/", localPath: "/downloads/" }]),
    };
    const mounts = { ...healthyMounts(), qbittorrent: [{ source: "/srv/downloads", destination: "/data/torrents" }] };
    const { result } = await run("qbittorrent", { routes, mounts });
    expect(check(result, "arr-save-path").status).toBe("pass");
    expect(check(result, "arr-save-path").evidence).toContain("remote path mapping");
  });
});

// ── Jellyfin ───────────────────────────────────────────────────────────────

describe("jellyfin probe", () => {
  it("verifies API, libraries and that library folders exist", async () => {
    const { result, calls } = await run("jellyfin");
    expect(result.status).toBe("verified");
    expect(check(result, "libraries").evidence).toContain("12 movies");
    expect(check(result, "library-paths").status).toBe("pass");
    const validate = calls.filter((c) => c.url.endsWith("/Environment/ValidatePath"));
    expect(validate).toHaveLength(2);
    expect(JSON.parse(validate[0].body ?? "{}").ValidateWritable).toBe(false); // read-only
  });

  it("fails when a library folder is missing (e.g. unmounted drive)", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`POST ${URLS.jellyfin}/Environment/ValidatePath`]: (_url: URL, init: RequestInit) =>
        JSON.parse(String(init.body)).Path === "/data/media/movies" ? jsonResponse({}, 404) : textResponse("", 204),
    };
    const { result } = await run("jellyfin", { routes });
    expect(check(result, "library-paths").status).toBe("fail");
    expect(check(result, "library-paths").evidence).toContain("/data/media/movies");
    expect(result.status).toBe("degraded");
  });

  it("fails when there are no libraries", async () => {
    const { result } = await run("jellyfin", { routes: { ...healthyMediaRoutes(), [`GET ${URLS.jellyfin}/Library/VirtualFolders`]: jsonResponse([]) } });
    expect(check(result, "libraries").status).toBe("fail");
    expect(check(result, "library-paths").status).toBe("skip");
  });

  it("sends the token only as a header, never in evidence", async () => {
    const { result, calls } = await run("jellyfin");
    expect(calls[0].headers.authorization).toBe(`MediaBrowser Token="${SECRETS.jellyfin}"`);
    expectNoSecrets(result);
  });
});

// ── Overseerr / Jellyseerr ─────────────────────────────────────────────────

describe("overseerr/jellyseerr probe", () => {
  it("verifies media-server and Sonarr/Radarr connectivity without leaking their keys", async () => {
    const { result } = await run("overseerr");
    expect(result.status).toBe("verified");
    expect(check(result, "media-server").evidence).toContain("Jellyfin");
    expect(check(result, "arr-connectivity").evidence).toContain("Sonarr");
    expectNoSecrets(result);
  });

  it("fails when it can't reach Sonarr", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`POST ${URLS.overseerr}/api/v1/settings/sonarr/test`]: jsonResponse({ message: "Failed to connect to Sonarr" }, 500),
    };
    const { result } = await run("overseerr", { routes });
    expect(check(result, "arr-connectivity").status).toBe("fail");
    expect(check(result, "arr-connectivity").evidence).toContain("Failed to connect");
  });

  it("warns when only one *arr is configured and fails with no media server", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.overseerr}/api/v1/settings/radarr`]: jsonResponse([]),
      [`GET ${URLS.overseerr}/api/v1/settings/jellyfin`]: jsonResponse({ ip: "", libraries: [] }),
      [`GET ${URLS.overseerr}/api/v1/settings/plex`]: jsonResponse({ ip: "" }),
    };
    const { result } = await run("overseerr", { routes });
    expect(check(result, "arr").status).toBe("warn");
    expect(check(result, "media-server").status).toBe("fail");
  });

  it("checks Plex for upstream (Plex-only) Overseerr", async () => {
    const connected = await run("overseerr", {
      routes: plexOnlyOverseerrRoutes({ name: "home", ip: "plex", port: 32400, libraries: [{ name: "Movies", enabled: true }] }),
    });
    expect(check(connected.result, "media-server").status).toBe("pass");
    expect(check(connected.result, "media-server").evidence).toContain("Plex at plex:32400");

    // Plex is the user's media server but Overseerr isn't connected to it: a real, fixable failure.
    const notConnected = await run("overseerr", { settings: { ...mediaSettings(), plex_url: "http://plex:32400" }, routes: plexOnlyOverseerrRoutes() });
    const c = check(notConnected.result, "media-server");
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain("Settings → Plex");
    expect(c.remediation).not.toContain("overseerr_configure_jellyfin");

    // Jellyfin only: nothing to connect Overseerr to — say so instead of pointing at a tool that can't work.
    const jellyfinOnly = check((await run("overseerr", { routes: plexOnlyOverseerrRoutes() })).result, "media-server");
    expect(jellyfinOnly.status).toBe("warn");
    expect(jellyfinOnly.remediation).toContain("Jellyseerr");
  });

  it("jellyseerr falls back to the overseerr connection settings", async () => {
    const { result } = await run("jellyseerr");
    expect(check(result, "api").status).toBe("pass");
    expect(result.targetId).toBe("jellyseerr");
  });
});

// ── Immich ─────────────────────────────────────────────────────────────────

function immichRoutes(overrides: Record<string, RouteHandler | "hang"> = {}): Record<string, RouteHandler | "hang"> {
  return {
    [`GET ${URLS.immich}/api/server/ping`]: jsonResponse({ res: "pong" }),
    [`GET ${URLS.immich}/api/server/version`]: jsonResponse({ major: 2, minor: 0, patch: 0 }),
    [`GET ${URLS.immich}/api/users/me`]: jsonResponse({ email: "a@b.c" }),
    [`GET ${URLS.immich}/api/server/storage`]: jsonResponse({ diskSize: "2 TiB", diskAvailable: "1.5 TiB", diskUsagePercentage: 25, diskSizeRaw: 2 * 1024 ** 4, diskAvailableRaw: 1.5 * 1024 ** 4 }),
    [`GET ${URLS.immich}/api/server/statistics`]: jsonResponse({ photos: 1200, videos: 40 }),
    [`GET ${URLS.immich}/api/server/config`]: jsonResponse({ externalDomain: "" }),
    "GET https://photos.example.com/api/server/ping": jsonResponse({ res: "pong" }),
    ...overrides,
  };
}
const immichSettings = { immich_url: URLS.immich, immich_api_key: SECRETS.immich };

describe("immich probe", () => {
  it("verifies server, storage and a phone-reachable URL", async () => {
    const { result } = await run("immich", { settings: { ...immichSettings, immich_external_url: "https://photos.example.com" }, routes: immichRoutes() });
    expect(result.status).toBe("verified");
    expect(check(result, "api").evidence).toContain("v2.0.0");
    expect(check(result, "storage").evidence).toContain("1200 photos");
    expect(check(result, "mobile-url").evidence).toContain("https://photos.example.com");
    expectNoSecrets(result);
  });

  it("uses Immich's External Domain when Talome has no external URL", async () => {
    const { result } = await run("immich", {
      settings: immichSettings,
      routes: immichRoutes({ [`GET ${URLS.immich}/api/server/config`]: jsonResponse({ externalDomain: "https://photos.example.com" }) }),
    });
    expect(check(result, "mobile-url").status).toBe("pass");
    expect(check(result, "mobile-url").evidence).toContain("External Domain");
  });

  it("warns with LAN guidance when no external URL exists, and fails for localhost", async () => {
    const none = await run("immich", { settings: immichSettings, routes: immichRoutes() });
    expect(check(none.result, "mobile-url").status).toBe("warn");
    expect(check(none.result, "mobile-url").evidence).toContain("http://192.168.1.20:2283");
    expect(none.result.status).toBe("degraded");

    const loop = await run("immich", { settings: { ...immichSettings, immich_external_url: "http://localhost:2283" }, routes: immichRoutes() });
    expect(check(loop.result, "mobile-url").status).toBe("fail");
  });

  it("fails storage when the drive is nearly full and fails the URL when unreachable", async () => {
    const { result } = await run("immich", {
      settings: { ...immichSettings, immich_external_url: "https://photos.example.com" },
      routes: immichRoutes({
        [`GET ${URLS.immich}/api/server/storage`]: jsonResponse({ diskUsagePercentage: 97, diskSizeRaw: 100, diskAvailableRaw: 3 }),
        "GET https://photos.example.com/api/server/ping": jsonResponse({ message: "Bad gateway" }, 502),
      }),
    });
    expect(check(result, "storage").status).toBe("fail");
    expect(check(result, "mobile-url").status).toBe("fail");
  });

  it("warns (not fails) without an API key and skips storage", async () => {
    const { result } = await run("immich", { settings: { immich_url: URLS.immich }, routes: immichRoutes() });
    expect(check(result, "auth").status).toBe("warn");
    expect(check(result, "storage").status).toBe("skip");
  });

  it("fails when the URL isn't an Immich server", async () => {
    const { result } = await run("immich", { settings: immichSettings, routes: immichRoutes({ [`GET ${URLS.immich}/api/server/ping`]: textResponse("<html>") }) });
    expect(result.status).toBe("failed");
  });
});

// ── Audiobookshelf / Home Assistant ────────────────────────────────────────

describe("audiobookshelf probe", () => {
  const settings = { audiobookshelf_url: URLS.abs, audiobookshelf_api_key: SECRETS.abs };
  it("verifies libraries", async () => {
    const { result, calls } = await run("audiobookshelf", {
      settings,
      routes: {
        [`GET ${URLS.abs}/api/me`]: jsonResponse({ username: "root" }),
        [`GET ${URLS.abs}/api/libraries`]: jsonResponse({ libraries: [{ name: "Audiobooks", mediaType: "book", folders: [{ fullPath: "/audiobooks" }] }] }),
      },
    });
    expect(result.status).toBe("verified");
    expect(calls[0].headers.authorization).toBe(`Bearer ${SECRETS.abs}`);
    expectNoSecrets(result);
  });
  it("fails without libraries", async () => {
    const { result } = await run("audiobookshelf", {
      settings,
      routes: { [`GET ${URLS.abs}/api/me`]: jsonResponse({}), [`GET ${URLS.abs}/api/libraries`]: jsonResponse({ libraries: [] }) },
    });
    expect(check(result, "libraries").status).toBe("fail");
  });
});

describe("home assistant probe", () => {
  const settings = { homeassistant_url: URLS.hass, homeassistant_token: SECRETS.hass };
  it("verifies API and core state", async () => {
    const { result } = await run("homeassistant", {
      settings,
      routes: {
        [`GET ${URLS.hass}/api/`]: jsonResponse({ message: "API running." }),
        [`GET ${URLS.hass}/api/config`]: jsonResponse({ version: "2026.9.1", state: "RUNNING", safe_mode: false, location_name: "Home" }),
      },
    });
    expect(result.status).toBe("verified");
    expect(check(result, "core").evidence).toContain("2026.9.1");
  });
  it("warns in safe mode and fails on a rejected token", async () => {
    const safe = await run("homeassistant", {
      settings,
      routes: {
        [`GET ${URLS.hass}/api/`]: jsonResponse({ message: "API running." }),
        [`GET ${URLS.hass}/api/config`]: jsonResponse({ version: "2026.9.1", state: "RUNNING", safe_mode: true }),
      },
    });
    expect(check(safe.result, "core").status).toBe("warn");

    const denied = await run("homeassistant", { settings, routes: { [`GET ${URLS.hass}/api/`]: jsonResponse({ message: "401: Unauthorized" }, 401) } });
    expect(denied.result.status).toBe("failed");
    expect(check(denied.result, "api").remediation).toContain("homeassistant_token");
    expectNoSecrets(denied.result);
  });
});
