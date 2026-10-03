import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
const mocks = vi.hoisted(() => ({ get: vi.fn(), containers: vi.fn() }));
vi.mock("../db/index.js", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: mocks.get }) }) }) }, schema: { installedApps: { appId: "appId" }, appCatalog: { appId: "appId", storeSourceId: "store" } } }));
vi.mock("../docker/client.js", () => ({ listContainers: mocks.containers, parseTcpDockerHost: () => null }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => false }));
vi.mock("../utils/settings.js", () => ({ getSetting: () => undefined }));
import { resolveGeneratedAppUrl } from "../app-specs/generated-connection.js";
import { executeAppApiRequest } from "../ai/tools/universal-tools.js";
function installation(port = 5013) {
  mocks.get.mockReturnValueOnce({ appId: "viewer", storeSourceId: "user-apps" }).mockReturnValueOnce({ ports: JSON.stringify([{ host: 5013, container: 3000 }]), composePath: "/apps/viewer/compose.yml" });
  mocks.containers.mockResolvedValue([{ id: "own", name: "viewer-app", status: "running", labels: { "com.docker.compose.project": "viewer" }, ports: [{ host: port, container: 3000, protocol: "tcp" }] }]);
}
beforeEach(() => { mocks.get.mockReset(); mocks.containers.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
describe("managed creation connections", () => {
  it("uses live remapped ports without a manual URL setting", async () => {
    installation(6013);
    expect(await resolveGeneratedAppUrl("viewer")).toEqual({ baseUrl: "http://127.0.0.1:6013" });
  });
  it("does not connect to uninstalled or other-store apps", async () => {
    mocks.get.mockReturnValue({ storeSourceId: "umbrel" });
    expect(await resolveGeneratedAppUrl("viewer")).toHaveProperty("error");
    expect(mocks.containers).not.toHaveBeenCalled();
  });
  it("does not trust similarly named containers outside the compose project", async () => {
    installation();
    mocks.containers.mockResolvedValue([{ name: "viewer-app", status: "running", labels: { "com.docker.compose.project": "other" }, ports: [{ host: 5013, container: 3000, protocol: "tcp" }] }]);
    expect(await resolveGeneratedAppUrl("viewer")).toHaveProperty("error");
  });
  it("rejects ambiguous published services", async () => {
    installation();
    mocks.containers.mockResolvedValue([{ name: "viewer", status: "running", labels: { "com.docker.compose.project": "viewer" }, ports: [{ host: 5013, container: 3000, protocol: "tcp" }, { host: 5014, container: 3000, protocol: "tcp" }] }]);
    expect(await resolveGeneratedAppUrl("viewer")).toHaveProperty("error");
  });
  it("selects an explicit manifest web port among multiple services", async () => {
    mocks.get.mockReturnValueOnce({ storeSourceId: "user-apps" }).mockReturnValueOnce({ webPort: 5013, ports: JSON.stringify([{ host: 5432, container: 5432 }, { host: 5013, container: 3000 }]), composePath: "/apps/viewer/compose.yml" });
    mocks.containers.mockResolvedValue([{ name: "viewer-app", status: "running", labels: { "com.docker.compose.project": "viewer" }, ports: [{ host: 6013, container: 3000, protocol: "tcp" }, { host: 5432, container: 5432, protocol: "tcp" }] }]);
    expect(await resolveGeneratedAppUrl("viewer")).toEqual({ baseUrl: "http://127.0.0.1:6013" });
  });
  it("fails closed when a multi-port manifest does not identify its web port", async () => {
    mocks.get.mockReturnValueOnce({ storeSourceId: "user-apps" }).mockReturnValueOnce({ ports: JSON.stringify([{ host: 5432, container: 5432 }, { host: 5013, container: 3000 }]) });
    expect(await resolveGeneratedAppUrl("viewer")).toHaveProperty("error");
    expect(mocks.containers).not.toHaveBeenCalled();
  });
  it("rejects stopped services", async () => {
    installation();
    mocks.containers.mockResolvedValue([]);
    expect(await resolveGeneratedAppUrl("viewer")).toHaveProperty("error");
  });
  it("reads and mutates a real isolated service through the API executor", async () => {
    let value = 0;
    const server = createServer((req, res) => { if (req.method === "POST") value++; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ value })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      installation(port);
      expect(await executeAppApiRequest({ appId: "viewer", path: "/api/state" })).toMatchObject({ success: true, data: { value: 0 } });
      installation(port);
      expect(await executeAppApiRequest({ appId: "viewer", path: "/api/state", method: "POST" })).toMatchObject({ success: true, data: { value: 1 } });
      installation(port);
      expect(await executeAppApiRequest({ appId: "viewer", path: "/api/state" })).toMatchObject({ success: true, data: { value: 1 } });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
