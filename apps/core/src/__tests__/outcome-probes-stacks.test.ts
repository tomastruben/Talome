import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-outcome-probes-stacks-${process.pid}.db`;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("real network disabled in tests"); }));

import { verifyStack, listVerifiableStacks, type VerificationResult } from "../verification/index.js";
import {
  SECRETS,
  URLS,
  allSecretValues,
  healthyMediaRoutes,
  healthyMounts,
  jsonResponse,
  makeDeps,
  mediaSettings,
  type RouteHandler,
} from "./outcome-probes-fixtures.js";
import type { MountInfo } from "../verification/env.js";

async function stack(
  stackId: string,
  opts: { settings?: Record<string, string>; routes?: Record<string, RouteHandler | "hang">; mounts?: Record<string, MountInfo[]> | null } = {},
) {
  const { deps } = makeDeps({
    settings: opts.settings ?? mediaSettings(),
    routes: opts.routes ?? healthyMediaRoutes(),
    mounts: opts.mounts === undefined ? healthyMounts() : opts.mounts,
  });
  const out = await verifyStack(stackId, { deps, persist: false });
  if (!out.ok) throw new Error(out.error);
  return out.result;
}

function link(result: VerificationResult, id: string) {
  const l = result.chain?.find((x) => x.id === id);
  if (!l) throw new Error(`link ${id} missing`);
  return l;
}

function check(result: VerificationResult, id: string) {
  const c = result.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing: ${result.checks.map((x) => x.id).join(", ")}`);
  return c;
}

describe("media-server stack chain", () => {
  it("verifies request → indexer → download → import → library end to end", async () => {
    const result = await stack("media-server");
    expect(result.status).toBe("verified");
    expect(result.chain?.map((l) => l.id)).toEqual(["request", "indexer", "download", "import", "library"]);
    expect(result.chain?.every((l) => l.status === "pass")).toBe(true);
    expect(check(result, "import:sonarr").evidence).toContain("same host folder /srv/downloads");
    expect(check(result, "library:radarr").evidence).toContain("/srv/media/movies");
    const json = JSON.stringify(result);
    for (const s of allSecretValues()) expect(json).not.toContain(s);
  });

  it("accepts the 'media' alias", async () => {
    const result = await stack("media");
    expect(result.targetId).toBe("media-server");
  });

  it("fails the import link when qBittorrent and Sonarr use different download folders", async () => {
    const mounts = { ...healthyMounts(), sonarr: [{ source: "/srv/media/tv", destination: "/tv" }, { source: "/home/me/Downloads", destination: "/downloads" }] };
    const result = await stack("media-server", { mounts });
    expect(result.status).toBe("failed");
    expect(link(result, "import").status).toBe("fail");
    expect(check(result, "import:sonarr").status).toBe("fail");
    expect(check(result, "import:radarr").status).toBe("pass");
    expect(link(result, "download").status).toBe("pass");
    expect(result.summary).toContain("failed");
  });

  it("fails the library link when a root folder isn't inside any Jellyfin library, and names the folder to add", async () => {
    const mounts = { ...healthyMounts(), radarr: [{ source: "/mnt/films", destination: "/movies" }, { source: "/srv/downloads", destination: "/downloads" }], jellyfin: [{ source: "/srv/media", destination: "/data/media" }, { source: "/mnt/films", destination: "/films" }] };
    const result = await stack("media-server", { mounts });
    const c = check(result, "library:radarr");
    expect(c.status).toBe("fail");
    expect(c.evidence).toContain("/mnt/films");
    expect(c.remediation).toContain("/films");
    expect(link(result, "library").status).toBe("fail");
    expect(result.status).toBe("failed");
  });

  it("only warns (never passes) on container-path comparison when Docker mounts are unavailable", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.sonarr}/api/v3/rootfolder`]: jsonResponse([{ path: "/data/media/tv", accessible: true, freeSpace: 1e12 }]),
      [`GET ${URLS.radarr}/api/v3/rootfolder`]: jsonResponse([{ path: "/movies", accessible: true, freeSpace: 1e12 }]),
    };
    const result = await stack("media-server", { routes, mounts: null });
    // Matching container paths are a hint, not proof — different host folders
    // could sit behind them, so the result is a warning, never a pass.
    expect(check(result, "library:sonarr").status).toBe("warn");
    expect(check(result, "library:sonarr").evidence).toContain("container path only");
    // /movies vs /data/media/movies can't be proven without mounts → warn, not a false failure
    expect(check(result, "library:radarr").status).toBe("warn");
    expect(check(result, "import:sonarr").status).toBe("warn");
    expect(check(result, "import:sonarr").evidence).toContain("isn't proven");
    expect(result.status).toBe("degraded");
  });

  it("fails the indexer link when an *arr has no indexers and marks Prowlarr sync separately", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.radarr}/api/v3/indexer`]: jsonResponse([]),
      [`GET ${URLS.prowlarr}/api/v1/applications`]: jsonResponse([{ name: "Sonarr", implementation: "Sonarr", syncLevel: "fullSync" }]),
    };
    const result = await stack("media-server", { routes });
    expect(link(result, "indexer").status).toBe("fail");
    expect(check(result, "indexer:prowlarr-sync").status).toBe("warn");
    expect(check(result, "indexer:prowlarr-sync").critical).toBe(false);
  });

  it("fails the request link when Overseerr can't reach Radarr", async () => {
    const routes = { ...healthyMediaRoutes(), [`POST ${URLS.overseerr}/api/v1/settings/radarr/test`]: jsonResponse({ message: "ECONNREFUSED" }, 500) };
    const result = await stack("media-server", { routes });
    expect(link(result, "request").status).toBe("fail");
    expect(result.status).toBe("failed");
  });

  it("treats a missing request app as optional", async () => {
    const settings = mediaSettings();
    delete settings.overseerr_url;
    delete settings.overseerr_api_key;
    const result = await stack("media-server", { settings });
    expect(check(result, "request:none").status).toBe("skip");
    expect(check(result, "request:none").critical).toBe(false);
    expect(result.status).toBe("verified");
  });

  it("uses *arr health for the import link when the download client isn't qBittorrent", async () => {
    const sab = jsonResponse([{ id: 2, name: "SABnzbd", enable: true, protocol: "usenet", implementation: "Sabnzbd", fields: [{ name: "apiKey", value: "SAB-SECRET-KEY-42" }] }]);
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.sonarr}/api/v3/downloadclient`]: sab,
      [`GET ${URLS.sonarr}/api/v3/health`]: jsonResponse([{ source: "RemotePathMappingCheck", type: "error", message: "Remote download client SABnzbd places downloads in /complete but this directory does not appear to exist" }]),
    };
    const result = await stack("media-server", { routes });
    const c = check(result, "import:sonarr");
    expect(c.status).toBe("fail");
    expect(c.evidence).toContain("/complete");
    expect(JSON.stringify(result)).not.toContain("SAB-SECRET-KEY-42");
  });

  it("is unknown (not verified) when no *arr app is connected", async () => {
    const result = await stack("media-server", { settings: { jellyfin_url: URLS.jellyfin, jellyfin_api_key: SECRETS.jellyfin } });
    expect(result.status).toBe("unknown");
    expect(check(result, "arr").status).toBe("skip");
  });

  it("marks the whole chain failed when Sonarr is down (dependent links are skipped, not guessed)", async () => {
    const routes = { ...healthyMediaRoutes(), [`GET ${URLS.sonarr}/api/v3/system/status`]: "hang" as const };
    const { deps } = makeDeps({ settings: mediaSettings(), routes, mounts: healthyMounts() });
    const out = await verifyStack("media-server", { deps, persist: false, timeoutMs: 40 });
    if (!out.ok) throw new Error(out.error);
    expect(check(out.result, "sonarr:api").status).toBe("timeout");
    expect(check(out.result, "download:sonarr").status).toBe("skip");
    expect(check(out.result, "import:sonarr").status).toBe("skip");
    expect(out.result.status).toBe("failed");
  });
});

describe("other stacks", () => {
  it("photo-management verifies the Immich outcome chain", async () => {
    const routes: Record<string, RouteHandler> = {
      [`GET ${URLS.immich}/api/server/ping`]: jsonResponse({ res: "pong" }),
      [`GET ${URLS.immich}/api/server/version`]: jsonResponse({ major: 2, minor: 0, patch: 0 }),
      [`GET ${URLS.immich}/api/users/me`]: jsonResponse({}),
      [`GET ${URLS.immich}/api/server/storage`]: jsonResponse({ diskUsagePercentage: 40, diskSizeRaw: 1e12, diskAvailableRaw: 6e11 }),
      [`GET ${URLS.immich}/api/server/config`]: jsonResponse({ externalDomain: "https://photos.example.com" }),
      "GET https://photos.example.com/api/server/ping": jsonResponse({ res: "pong" }),
    };
    const result = await stack("photos", { settings: { immich_url: URLS.immich, immich_api_key: SECRETS.immich }, routes });
    expect(result.targetId).toBe("photo-management");
    expect(result.status).toBe("verified");
    expect(result.chain?.map((l) => [l.id, l.status])).toEqual([["server", "pass"], ["storage", "pass"], ["mobile", "pass"]]);
    expect(JSON.stringify(result)).not.toContain(SECRETS.immich);
  });

  it("books checks that Readarr imports land in an Audiobookshelf library", async () => {
    const settings = { audiobookshelf_url: URLS.abs, audiobookshelf_api_key: SECRETS.abs, readarr_url: "http://readarr:8787", readarr_api_key: "READARR-KEY-XYZ" };
    const routes: Record<string, RouteHandler> = {
      [`GET ${URLS.abs}/api/me`]: jsonResponse({ username: "root" }),
      [`GET ${URLS.abs}/api/libraries`]: jsonResponse({ libraries: [{ name: "Books", mediaType: "book", folders: [{ fullPath: "/audiobooks" }] }] }),
      "GET http://readarr:8787/api/v1/system/status": jsonResponse({ version: "0.4" }),
      "GET http://readarr:8787/api/v1/rootfolder": jsonResponse([{ path: "/books", accessible: true }]),
    };
    const mounts = { readarr: [{ source: "/srv/audiobooks", destination: "/books" }], audiobookshelf: [{ source: "/srv/audiobooks", destination: "/audiobooks" }] };
    const result = await stack("books", { settings, routes, mounts });
    expect(check(result, "import:readarr").status).toBe("pass");
    expect(result.status).toBe("verified");
  });

  it("smart-home verifies Home Assistant", async () => {
    const result = await stack("smart-home", {
      settings: { homeassistant_url: URLS.hass, homeassistant_token: SECRETS.hass },
      routes: {
        [`GET ${URLS.hass}/api/`]: jsonResponse({ message: "API running." }),
        [`GET ${URLS.hass}/api/config`]: jsonResponse({ version: "2026.9.1", state: "RUNNING" }),
      },
    });
    expect(result.status).toBe("verified");
  });

  it("rejects stacks without an outcome probe", async () => {
    const out = await verifyStack("developer-lab", { persist: false });
    expect(out.ok).toBe(false);
    expect(listVerifiableStacks().map((s) => s.id)).toContain("media-server");
  });
});
