import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  listContainers: vi.fn(),
  inspectContainer: vi.fn(),
  inspectImage: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../docker/client.js", () => ({
  // The cached helper must NOT be used by the probes — they list fresh.
  listContainers: vi.fn(async () => { throw new Error("cached listContainers must not be used"); }),
  docker: {
    listContainers: m.listContainers,
    getContainer: (id: string) => ({ inspect: () => m.inspectContainer(id) }),
    getImage: (id: string) => ({ inspect: () => m.inspectImage(id) }),
  },
}));
vi.mock("../stores/compose-exec.js", () => ({ run: m.run }));

import {
  verifyAppHealth,
  captureServiceImages,
  restoreServiceImages,
  selectAppContainers,
  findAppContainers,
  healthcheckBudgetMs,
  splitImageRef,
  isSafeImageRef,
  type ServiceImageState,
} from "../ops/docker-probe.js";

/** Raw Docker API list entry (docker.listContainers). Ids are ≤12 chars so they survive slicing. */
function container(name: string, service = name, labels: Record<string, string> = {}) {
  return {
    Id: `${name}-id`.slice(0, 12),
    Names: [`/${name}`],
    Image: `org/${name}:1`,
    State: "running",
    Labels: { "com.docker.compose.service": service, ...labels },
  };
}

function state(opts: { running?: boolean; restarting?: boolean; health?: string; restarts?: number; healthcheck?: Record<string, unknown> }) {
  return {
    Image: "sha256:" + "c".repeat(64),
    Config: { Image: "org/app:1", ...(opts.healthcheck ? { Healthcheck: opts.healthcheck } : {}) },
    RestartCount: opts.restarts ?? 0,
    State: {
      Running: opts.running ?? true,
      Restarting: opts.restarting ?? false,
      Status: opts.running === false ? "exited" : "running",
      ...(opts.health ? { Health: { Status: opts.health } } : {}),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.listContainers.mockResolvedValue([container("app")]);
});

describe("verifyAppHealth", () => {
  it("is healthy after consecutive stable observations", async () => {
    m.inspectContainer.mockResolvedValue(state({}));
    const r = await verifyAppHealth("app", { requiredServices: ["app"], stableChecks: 2, intervalMs: 1, timeoutMs: 1000 });
    expect(r.healthy).toBe(true);
    expect(r.verdict).toBe("healthy");
    expect(r.checks).toBe(2);
  });

  it("waits for a starting healthcheck to become healthy", async () => {
    m.inspectContainer
      .mockResolvedValueOnce(state({ health: "starting" }))
      .mockResolvedValue(state({ health: "healthy" }));
    const r = await verifyAppHealth("app", { stableChecks: 2, intervalMs: 1, timeoutMs: 1000 });
    expect(r.healthy).toBe(true);
    expect(r.checks).toBe(3);
  });

  it("detects a crash loop through increasing restart counts (hard failure, ends early)", async () => {
    let restarts = 0;
    m.inspectContainer.mockImplementation(async () => state({ restarts: restarts++ }));
    const r = await verifyAppHealth("app", { stableChecks: 3, intervalMs: 1, timeoutMs: 60_000 });
    expect(r.healthy).toBe(false);
    expect(r.verdict).toBe("unhealthy");
    expect(r.reason).toContain("restart loop");
    expect(r.elapsedMs).toBeLessThan(5_000);
  });

  it("a single restart during init is not a failure once the container stays up", async () => {
    const counts = [0, 1, 1, 1, 1, 1];
    let i = 0;
    m.inspectContainer.mockImplementation(async () => state({ restarts: counts[Math.min(i++, counts.length - 1)] }));
    const r = await verifyAppHealth("app", { requiredServices: ["app"], stableChecks: 2, intervalMs: 1, timeoutMs: 1000 });
    expect(r.verdict).toBe("healthy");
  });

  it("fails when a previously running service is not running", async () => {
    m.inspectContainer.mockResolvedValue(state({ running: false }));
    const r = await verifyAppHealth("app", { requiredServices: ["app"], stableChecks: 1, intervalMs: 1, timeoutMs: 20 });
    expect(r.healthy).toBe(false);
    expect(r.verdict).toBe("unhealthy");
    expect(r.reason).toBe('Service "app" is not running');
  });

  it("an unhealthy healthcheck is a hard failure", async () => {
    m.inspectContainer.mockResolvedValue(state({ health: "unhealthy" }));
    const r = await verifyAppHealth("app", { stableChecks: 1, intervalMs: 1, timeoutMs: 60_000, hardFailChecks: 2 });
    expect(r.verdict).toBe("unhealthy");
    expect(r.checks).toBe(2);
  });

  it("a healthcheck still 'starting' at the deadline is inconclusive, not unhealthy", async () => {
    m.inspectContainer.mockResolvedValue(state({ health: "starting" }));
    const r = await verifyAppHealth("app", { stableChecks: 1, intervalMs: 1, timeoutMs: 20, maxTimeoutMs: 20 });
    expect(r.healthy).toBe(false);
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toContain("starting");
  });

  it("extends the deadline to the healthcheck's start_period + interval × retries", async () => {
    const ms = 1_000_000; // ns per ms
    const healthcheck = { Test: ["CMD", "true"], Interval: 10 * ms, Retries: 3, StartPeriod: 40 * ms }; // 70ms budget
    let calls = 0;
    m.inspectContainer.mockImplementation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return state({ health: calls < 6 ? "starting" : "healthy", healthcheck });
    });
    // Base timeout (10ms) alone would give up while still "starting".
    const r = await verifyAppHealth("app", { stableChecks: 1, intervalMs: 1, timeoutMs: 10, maxTimeoutMs: 5_000 });
    expect(r.verdict).toBe("healthy");
  });

  it("a container that cannot be inspected is never counted as healthy", async () => {
    m.inspectContainer.mockRejectedValue(new Error("No such container"));
    const r = await verifyAppHealth("app", { requiredServices: ["app"], stableChecks: 1, intervalMs: 1, timeoutMs: 20 });
    expect(r.healthy).toBe(false);
    expect(r.verdict).toBe("inconclusive");
  });

  it("a UI answering 5xx (maintenance/migration) is inconclusive, not unhealthy", async () => {
    m.inspectContainer.mockResolvedValue(state({}));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("maintenance", { status: 503 }));
    try {
      const r = await verifyAppHealth("app", { webPort: 8080, requireHttp: true, stableChecks: 1, intervalMs: 1, timeoutMs: 20 });
      expect(r.verdict).toBe("inconclusive");
      expect(r.reason).toContain("HTTP 503");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("ignores one-shot services that were not running before the update", async () => {
    m.listContainers.mockResolvedValue([container("app"), container("app-init", "init")]);
    m.inspectContainer.mockImplementation(async (id: string) => (id === "app-init-id" ? state({ running: false }) : state({})));
    const r = await verifyAppHealth("app", { requiredServices: ["app"], stableChecks: 1, intervalMs: 1, timeoutMs: 1000 });
    expect(r.healthy).toBe(true);
  });

  it("requires the web UI when asked", async () => {
    m.inspectContainer.mockResolvedValue(state({}));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      const r = await verifyAppHealth("app", { webPort: 8080, requireHttp: true, stableChecks: 1, intervalMs: 1, timeoutMs: 20 });
      expect(r.healthy).toBe(false);
      expect(r.verdict).toBe("inconclusive");
      expect(r.reason).toContain("port 8080");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("container matching", () => {
  const project = (p: string) => ({ "com.docker.compose.project": p });

  it("does not pick up another app whose id starts with this one (plex vs plex-meta-manager)", () => {
    const all = [
      { name: "plex", labels: project("plex") },
      { name: "plex-meta-manager", labels: project("plex-meta-manager") },
      { name: "plex-4k", labels: project("plex-4k") },
    ];
    expect(selectAppContainers(all, "plex").map((c) => c.name)).toEqual(["plex"]);
  });

  it("prefers the compose config_files label of the app's compose file", () => {
    const all = [
      { name: "whatever-1", labels: { "com.docker.compose.project.config_files": "/data/apps/plex/docker-compose.yml", ...project("custom") } },
      { name: "plex-meta-manager", labels: project("plex-meta-manager") },
    ];
    expect(selectAppContainers(all, "plex", "/data/apps/plex/docker-compose.yml").map((c) => c.name)).toEqual(["whatever-1"]);
  });

  it("falls back to names only when no labelled container exists, still excluding sibling projects", () => {
    const all = [
      { name: "sonarr", labels: {} },
      { name: "sonarr-4k", labels: project("sonarr-4k") },
      { name: "sonarr_helper", labels: {} },
    ];
    expect(selectAppContainers(all, "sonarr").map((c) => c.name)).toEqual(["sonarr", "sonarr_helper"]);
  });

  it("lists containers straight from the Docker API (no cache)", async () => {
    m.listContainers.mockResolvedValue([container("app", "app", project("app")), container("other")]);
    const found = await findAppContainers("app");
    expect(found.map((c) => c.name)).toEqual(["app"]);
    expect(m.listContainers).toHaveBeenCalledWith({ all: true });
  });

  it("computes the healthcheck budget from inspect data (nanoseconds)", () => {
    const ms = 1_000_000;
    expect(healthcheckBudgetMs({ Test: ["CMD", "x"], Interval: 30_000 * ms, Retries: 5, StartPeriod: 120_000 * ms })).toBe(270_000);
    expect(healthcheckBudgetMs({ Test: ["CMD", "x"] })).toBe(90_000);
    expect(healthcheckBudgetMs({ Test: ["NONE"] })).toBeUndefined();
    expect(healthcheckBudgetMs(undefined)).toBeUndefined();
  });
});

describe("captureServiceImages", () => {
  it("records image ref, image id and the matching repo digest per service", async () => {
    m.inspectContainer.mockResolvedValue(state({}));
    m.inspectImage.mockResolvedValue({ RepoDigests: ["mirror/app@sha256:" + "1".repeat(64), "org/app@sha256:" + "2".repeat(64)] });
    const [s] = await captureServiceImages("app");
    expect(s).toMatchObject({
      service: "app",
      imageRef: "org/app:1",
      imageId: "sha256:" + "c".repeat(64),
      repoDigest: "org/app@sha256:" + "2".repeat(64),
      status: "running",
    });
  });
});

describe("restoreServiceImages", () => {
  const base: ServiceImageState = {
    service: "app",
    containerId: "x",
    containerName: "app",
    imageRef: "org/app:1",
    imageId: "sha256:" + "c".repeat(64),
    repoDigest: "org/app@sha256:" + "d".repeat(64),
    status: "running",
  };

  it("re-tags the previous local image", async () => {
    m.run.mockResolvedValue({ stdout: "", stderr: "" });
    const r = await restoreServiceImages([base]);
    expect(r).toEqual([{ service: "app", restored: true, method: "tag" }]);
    expect(m.run).toHaveBeenCalledWith(`docker tag "${base.imageId}" "org/app:1"`, expect.anything());
  });

  it("falls back to pulling the recorded digest when the image was pruned", async () => {
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith(`docker tag "${base.imageId}"`)) throw new Error("No such image");
      return { stdout: "", stderr: "" };
    });
    const r = await restoreServiceImages([base]);
    expect(r[0]).toEqual({ service: "app", restored: true, method: "pull" });
    expect(m.run).toHaveBeenCalledWith(`docker pull "${base.repoDigest}"`, expect.anything());
  });

  it("refuses unsafe references", async () => {
    const r = await restoreServiceImages([{ ...base, imageRef: "org/app:1; rm -rf /" }]);
    expect(r[0].restored).toBe(false);
    expect(m.run).not.toHaveBeenCalled();
  });
});

describe("image ref helpers", () => {
  it("splits refs with registry ports and digests", () => {
    expect(splitImageRef("registry:5000/org/app:2.1")).toEqual({ repo: "registry:5000/org/app", tag: "2.1" });
    expect(splitImageRef("org/app")).toEqual({ repo: "org/app", tag: "latest" });
    expect(splitImageRef("org/app@sha256:abc")).toEqual({ repo: "org/app", tag: null });
    expect(isSafeImageRef("org/app:1")).toBe(true);
    expect(isSafeImageRef("$(whoami)")).toBe(false);
  });
});
