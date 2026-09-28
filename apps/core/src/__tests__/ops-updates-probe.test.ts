import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  listContainers: vi.fn(),
  inspectContainer: vi.fn(),
  inspectImage: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../docker/client.js", () => ({
  listContainers: m.listContainers,
  docker: {
    getContainer: (id: string) => ({ inspect: () => m.inspectContainer(id) }),
    getImage: (id: string) => ({ inspect: () => m.inspectImage(id) }),
  },
}));
vi.mock("../stores/compose-exec.js", () => ({ run: m.run }));

import {
  verifyAppHealth,
  captureServiceImages,
  restoreServiceImages,
  splitImageRef,
  isSafeImageRef,
  type ServiceImageState,
} from "../ops/docker-probe.js";

function container(name: string, service = name) {
  return {
    id: `${name}-id`,
    name,
    image: `org/${name}:1`,
    status: "running",
    ports: [],
    created: "",
    labels: { "com.docker.compose.service": service },
  };
}

function state(opts: { running?: boolean; restarting?: boolean; health?: string; restarts?: number }) {
  return {
    Image: "sha256:" + "c".repeat(64),
    Config: { Image: "org/app:1" },
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

  it("detects a crash loop through increasing restart counts", async () => {
    let restarts = 0;
    m.inspectContainer.mockImplementation(async () => state({ restarts: restarts++ }));
    const r = await verifyAppHealth("app", { stableChecks: 3, intervalMs: 1, timeoutMs: 60 });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain("restarted");
  });

  it("fails when a previously running service is not running", async () => {
    m.inspectContainer.mockResolvedValue(state({ running: false }));
    const r = await verifyAppHealth("app", { requiredServices: ["app"], stableChecks: 1, intervalMs: 1, timeoutMs: 20 });
    expect(r.healthy).toBe(false);
    expect(r.reason).toBe('Service "app" is not running');
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
      expect(r.reason).toContain("port 8080");
    } finally {
      fetchMock.mockRestore();
    }
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
