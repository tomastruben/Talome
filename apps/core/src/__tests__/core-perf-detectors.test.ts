import { describe, it, expect, vi, beforeEach } from "vitest";

const dockerMock = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainerLogs: vi.fn(),
  getSystemStats: vi.fn(),
}));

vi.mock("../docker/client.js", () => dockerMock);
vi.mock("../utils/settings.js", () => ({ getSetting: vi.fn(() => undefined) }));
vi.mock("../app-registry/index.js", () => ({ APP_REGISTRY: {} }));
vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));

import {
  detectErrorSpikes,
  mergeLogWindow,
  parseDockerLogTimestamp,
  resetDetectorState,
} from "../agent-loop/detectors.js";

const ts = (sec: number, frac = "") => `2026-09-28T10:00:${String(sec).padStart(2, "0")}${frac}Z`;

function container(id: string, status = "running") {
  return { id, name: id, image: "img", status, ports: [], created: new Date().toISOString(), labels: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDetectorState();
});

describe("docker log timestamps", () => {
  it("normalises the nanosecond fraction so keys sort correctly", () => {
    const a = parseDockerLogTimestamp(`${ts(5, ".1")} hello`)!;
    const b = parseDockerLogTimestamp(`${ts(5, ".12")} world`)!;
    expect(a.key < b.key).toBe(true);
    expect(a.message).toBe("hello");
    expect(a.seconds).toBe(Math.floor(Date.parse("2026-09-28T10:00:05Z") / 1000));
  });

  it("tolerates stream-header residue before the timestamp", () => {
    expect(parseDockerLogTimestamp(`A${ts(1, ".5")} x`)?.message).toBe("x");
    expect(parseDockerLogTimestamp("no timestamp here")).toBeNull();
  });
});

describe("mergeLogWindow", () => {
  it("appends only lines newer than the last seen timestamp and caps the window", () => {
    const first = mergeLogWindow(undefined, [`${ts(1)} a`, `${ts(2)} b`].join("\n"));
    expect(first.lines).toHaveLength(2);

    // `since` is second-granular, so Docker re-sends ts(2).
    const second = mergeLogWindow(first, [`${ts(2)} b`, `${ts(3)} c`].join("\n"));
    expect(second.lines.map((l) => l.slice(-1))).toEqual(["a", "b", "c"]);
    expect(second.lastSeconds).toBe(Math.floor(Date.parse("2026-09-28T10:00:03Z") / 1000));

    const many = Array.from({ length: 150 }, (_, i) => `2026-09-28T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z line${i}`);
    const capped = mergeLogWindow(second, many.join("\n"));
    expect(capped.lines).toHaveLength(100);
    expect(capped.lines.at(-1)).toContain("line149");
  });
});

describe("detectErrorSpikes", () => {
  it("fetches logs with bounded concurrency and only new lines on later checks", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
    dockerMock.listContainers.mockResolvedValue([...ids.map((id) => container(id)), container("stopped", "exited")]);

    let active = 0;
    let peak = 0;
    dockerMock.getContainerLogs.mockImplementation(async (_id: string, _tail: number, opts?: { since?: number }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
      if (opts?.since !== undefined) return ""; // nothing new
      return Array.from({ length: 20 }, (_, i) => `${ts(i)} ERROR something failed`).join("\n");
    });

    const events = await detectErrorSpikes();
    expect(peak).toBeLessThanOrEqual(3);
    expect(dockerMock.getContainerLogs).toHaveBeenCalledTimes(8); // stopped container skipped
    expect(dockerMock.listContainers).toHaveBeenCalledWith({ cached: true });
    expect(events).toHaveLength(8);
    expect(events[0].type).toBe("error_spike");

    dockerMock.getContainerLogs.mockClear();
    await detectErrorSpikes();
    const calls = dockerMock.getContainerLogs.mock.calls;
    expect(calls).toHaveLength(8);
    expect(calls.every(([, , opts]) => opts?.since === Math.floor(Date.parse(ts(19)) / 1000))).toBe(true);
  });

  it("ignores INFO/DEBUG-prefixed lines even with the timestamp prefix", async () => {
    dockerMock.listContainers.mockResolvedValue([container("app")]);
    dockerMock.getContainerLogs.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => `${ts(i)} [INFO] retrying after error`).join("\n"),
    );
    expect(await detectErrorSpikes()).toHaveLength(0);
  });
});
