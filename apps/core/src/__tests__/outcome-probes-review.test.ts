import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "node:fs";

vi.hoisted(() => {
  process.env.DATABASE_PATH = `${process.env.TMPDIR ?? "/tmp"}/talome-outcome-probes-review-${process.pid}.db`;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${process.env.DATABASE_PATH}${suffix}`, { force: true });
});

vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("real network disabled in tests"); }));

import { verifyApp, verifyStack, type VerificationResult } from "../verification/index.js";
import { createProbeEnv, type MountInfo } from "../verification/env.js";
import { appRequest } from "../verification/http.js";
import { arrPathExists } from "../verification/probes/path-mapping.js";
import {
  URLS,
  healthyMediaRoutes,
  healthyMounts,
  jsonResponse,
  makeDeps,
  mediaSettings,
  servarrFilesystem,
  type RouteHandler,
} from "./outcome-probes-fixtures.js";

function check(result: VerificationResult, id: string) {
  const c = result.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} missing: ${result.checks.map((x) => x.id).join(", ")}`);
  return c;
}

async function stack(opts: { routes?: Record<string, RouteHandler | "hang">; mounts?: Record<string, MountInfo[]> | null; includeActive?: boolean } = {}) {
  const { deps, calls } = makeDeps({
    settings: mediaSettings(),
    routes: opts.routes ?? healthyMediaRoutes(),
    mounts: opts.mounts === undefined ? healthyMounts() : opts.mounts,
  });
  const out = await verifyStack("media-server", { deps, persist: false, includeActive: opts.includeActive });
  if (!out.ok) throw new Error(out.error);
  return { result: out.result, calls };
}

function ctxFor(routes: Record<string, RouteHandler | "hang">) {
  const { deps } = makeDeps({ settings: mediaSettings(), routes });
  const env = createProbeEnv(deps);
  return { env, signal: new AbortController().signal };
}

// ── *arr folder existence (real Servarr answers missing folders with a parent) ──

describe("arrPathExists", () => {
  it("does not treat Servarr's parent-only answer for a missing folder as existence", async () => {
    const ctx = ctxFor({ [`GET ${URLS.sonarr}/api/v3/filesystem`]: servarrFilesystem(["/tv"]) });
    expect(await arrPathExists(ctx, "sonarr", "/downloads")).toBe(false);
    expect(await arrPathExists(ctx, "sonarr", "/tv")).toBe(true);
    expect(await arrPathExists(ctx, "sonarr", "/tv/")).toBe(true);
  });

  it("proves nested folders through the parent listing", async () => {
    const ctx = ctxFor({ [`GET ${URLS.sonarr}/api/v3/filesystem`]: servarrFilesystem(["/data", "/data/torrents", "/data/torrents/tv"]) });
    expect(await arrPathExists(ctx, "sonarr", "/data/torrents/tv")).toBe(true);
    expect(await arrPathExists(ctx, "sonarr", "/data/torrents/movies")).toBe(false);
  });

  it("is unknown (null) when the *arr can't be asked", async () => {
    const ctx = ctxFor({ [`GET ${URLS.sonarr}/api/v3/filesystem`]: jsonResponse({ message: "boom" }, 500) });
    expect(await arrPathExists(ctx, "sonarr", "/downloads")).toBeNull();
  });
});

// ── Download path mapping ──────────────────────────────────────────────────

describe("download path mapping", () => {
  it("fails when the *arr cannot see qBittorrent's save path, even without Docker mounts", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.sonarr}/api/v3/filesystem`]: servarrFilesystem(["/tv"]),
    };
    const { result } = await stack({ routes, mounts: null });
    const c = check(result, "import:sonarr");
    expect(c.status).toBe("fail");
    expect(c.evidence).toContain("cannot see /downloads");
    expect(result.status).toBe("failed");
  });

  it("warns (not passes) when only one side's Docker mounts are known", async () => {
    const mounts = { ...healthyMounts() } as Record<string, MountInfo[]>;
    delete mounts.qbittorrent;
    const { result } = await stack({ mounts });
    const c = check(result, "import:sonarr");
    expect(c.status).toBe("warn");
    expect(c.evidence).toContain("Docker mounts for qBittorrent were unavailable");
  });

  it("fails when qBittorrent's save path isn't a mounted folder but the *arr's is", async () => {
    const mounts = { ...healthyMounts(), qbittorrent: [{ source: "/srv/config/qbt", destination: "/config" }] };
    const { result } = await stack({ mounts });
    const c = check(result, "import:radarr");
    expect(c.status).toBe("fail");
    expect(c.evidence).toContain("not a mounted folder");
    expect(c.remediation).toContain("/srv/downloads");
  });
});

// ── Library mapping ────────────────────────────────────────────────────────

describe("library path mapping", () => {
  it("fails when the root folder only contains a library instead of being inside one", async () => {
    // Sonarr imports into host /srv/media, but Jellyfin only has /srv/media/movies.
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.jellyfin}/Library/VirtualFolders`]: jsonResponse([{ Name: "Movies", CollectionType: "movies", Locations: ["/data/media/movies"] }]),
    };
    const mounts = { ...healthyMounts(), sonarr: [{ source: "/srv/media", destination: "/tv" }, { source: "/srv/downloads", destination: "/downloads" }] };
    const { result } = await stack({ routes, mounts });
    expect(check(result, "library:sonarr").status).toBe("fail");
    expect(check(result, "library:radarr").status).toBe("pass");
  });
});

// ── Request link ───────────────────────────────────────────────────────────

describe("request link", () => {
  it("fails (not unknown) when Overseerr has no Sonarr/Radarr servers", async () => {
    const routes = {
      ...healthyMediaRoutes(),
      [`GET ${URLS.overseerr}/api/v1/settings/sonarr`]: jsonResponse([]),
      [`GET ${URLS.overseerr}/api/v1/settings/radarr`]: jsonResponse([]),
    };
    const { result } = await stack({ routes });
    const configured = check(result, "request:overseerr:arr-configured");
    expect(configured.status).toBe("fail");
    expect(configured.critical).toBe(true);
    expect(configured.evidence).toContain("never downloaded");
    expect(check(result, "request:overseerr:arr").status).toBe("skip");
    expect(result.chain?.find((l) => l.id === "request")?.status).toBe("fail");
    expect(result.status).toBe("failed");
  });
});

// ── Active download-client test in the stack ───────────────────────────────

describe("stack active probes", () => {
  it("skips the download-client test by default and runs it with includeActive", async () => {
    const passive = await stack();
    expect(check(passive.result, "download:sonarr:test").status).toBe("skip");
    expect(passive.result.status).toBe("verified");
    expect(passive.calls.some((c) => c.url.endsWith("/downloadclient/test"))).toBe(false);

    const active = await stack({ includeActive: true });
    expect(check(active.result, "download:sonarr:test").status).toBe("pass");
    expect(active.result.includeActive).toBe(true);
    expect(active.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v3/downloadclient/test"))).toHaveLength(2);
  });

  it("fails the download link when the active test fails", async () => {
    const routes = { ...healthyMediaRoutes(), [`POST ${URLS.radarr}/api/v3/downloadclient/test`]: jsonResponse([{ errorMessage: "Unable to connect to qBittorrent" }], 400) };
    const { result } = await stack({ routes, includeActive: true });
    expect(check(result, "download:radarr:test").status).toBe("fail");
    expect(result.chain?.find((l) => l.id === "download")?.status).toBe("fail");
    expect(result.status).toBe("failed");
  });
});

// ── App-level status for functional failures ───────────────────────────────

describe("app status", () => {
  it("is failed (not degraded) when an *arr has no download client", async () => {
    const { deps } = makeDeps({ settings: mediaSettings(), routes: { ...healthyMediaRoutes(), [`GET ${URLS.sonarr}/api/v3/downloadclient`]: jsonResponse([]) }, mounts: healthyMounts() });
    const out = await verifyApp("sonarr", { deps, persist: false });
    if (!out.ok) throw new Error(out.error);
    expect(check(out.result, "download-client").status).toBe("fail");
    expect(out.result.status).toBe("failed");
  });

  it("is failed when Jellyfin has no libraries", async () => {
    const { deps } = makeDeps({ settings: mediaSettings(), routes: { ...healthyMediaRoutes(), [`GET ${URLS.jellyfin}/Library/VirtualFolders`]: jsonResponse([]) } });
    const out = await verifyApp("jellyfin", { deps, persist: false });
    if (!out.ok) throw new Error(out.error);
    expect(out.result.status).toBe("failed");
  });
});

// ── Robustness ─────────────────────────────────────────────────────────────

describe("robustness", () => {
  it("rejects prototype keys as app ids instead of crashing", async () => {
    for (const id of ["constructor", "__proto__", "toString"]) {
      const out = await verifyApp(id, { persist: false });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe("unknown_target");
    }
  });

  it("evicts an aborted GET from the run cache synchronously so the next check retries", async () => {
    let calls = 0;
    const routes: Record<string, RouteHandler> = {
      [`GET ${URLS.sonarr}/api/v3/rootfolder`]: (_url, init) => {
        calls++;
        if (calls === 1) {
          return new Promise<never>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          });
        }
        return jsonResponse([{ path: "/tv", accessible: true }]);
      },
    };
    const { deps } = makeDeps({ settings: mediaSettings(), routes });
    const env = createProbeEnv(deps);
    const first = new AbortController();
    const slow = appRequest({ env, signal: first.signal }, "sonarr", "/api/v3/rootfolder");
    await Promise.resolve();
    first.abort();
    // The runner starts the next check right after a timeout — before the aborted fetch settles.
    const retry = await appRequest({ env, signal: new AbortController().signal }, "sonarr", "/api/v3/rootfolder");
    expect(retry.ok).toBe(true);
    expect(calls).toBe(2);
    expect((await slow).ok).toBe(false);
  });
});
