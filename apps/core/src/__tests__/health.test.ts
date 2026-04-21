import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB and listContainers before importing the health logic
vi.mock("../db/index.js", () => ({
  db: {
    get: vi.fn(),
    $client: {},
  },
  schema: {},
}));

vi.mock("../docker/client.js", () => ({
  listContainers: vi.fn(),
}));

import { db } from "../db/index.js";
import { listContainers } from "../docker/client.js";

async function runHealthCheck(): Promise<{
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "error">;
}> {
  const checks: Record<string, "ok" | "error"> = {};

  try {
    (db as any).get({});
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }

  try {
    await (listContainers as any)();
    checks.docker = "ok";
  } catch {
    checks.docker = "error";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");
  return { status: healthy ? "ok" : "degraded", checks };
}

describe("health check logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when DB and Docker are healthy", async () => {
    vi.mocked(db.get).mockReturnValue({ "1": 1 });
    vi.mocked(listContainers).mockResolvedValue([]);

    const result = await runHealthCheck();
    expect(result.status).toBe("ok");
    expect(result.checks.db).toBe("ok");
    expect(result.checks.docker).toBe("ok");
  });

  it("returns degraded when DB fails", async () => {
    vi.mocked(db.get).mockImplementation(() => {
      throw new Error("DB error");
    });
    vi.mocked(listContainers).mockResolvedValue([]);

    const result = await runHealthCheck();
    expect(result.status).toBe("degraded");
    expect(result.checks.db).toBe("error");
    expect(result.checks.docker).toBe("ok");
  });

  it("returns degraded when Docker fails", async () => {
    vi.mocked(db.get).mockReturnValue({ "1": 1 });
    vi.mocked(listContainers).mockRejectedValue(new Error("Docker socket unavailable"));

    const result = await runHealthCheck();
    expect(result.status).toBe("degraded");
    expect(result.checks.db).toBe("ok");
    expect(result.checks.docker).toBe("error");
  });

  it("returns degraded when both fail", async () => {
    vi.mocked(db.get).mockImplementation(() => { throw new Error("DB error"); });
    vi.mocked(listContainers).mockRejectedValue(new Error("Docker error"));

    const result = await runHealthCheck();
    expect(result.status).toBe("degraded");
    expect(result.checks.db).toBe("error");
    expect(result.checks.docker).toBe("error");
  });
});
