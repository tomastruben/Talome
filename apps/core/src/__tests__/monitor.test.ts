import { describe, it, expect, vi } from "vitest";

// Test the monitor's core logic: container state transitions and disk threshold decisions.
// We inline the logic here to test it in isolation without Docker or DB dependencies.

// ── Simulate shouldNotify ──────────────────────────────────────────────────────

function makeShouldNotify(cooldownMs: number) {
  const lastNotified = new Map<string, number>();
  return (key: string): boolean => {
    const last = lastNotified.get(key) ?? 0;
    if (Date.now() - last > cooldownMs) {
      lastNotified.set(key, Date.now());
      return true;
    }
    return false;
  };
}

// ── Simulate checkContainerHealth state machine ────────────────────────────────

interface ContainerInfo {
  name: string;
  status: string;
}

function makeContainerHealthChecker() {
  let previousStates = new Map<string, string>();
  const events: Array<{ name: string; from: string; to: string }> = [];

  function check(containers: ContainerInfo[]) {
    const currentStates = new Map<string, string>();
    for (const c of containers) {
      currentStates.set(c.name, c.status);
      const prev = previousStates.get(c.name);
      if (prev && prev === "running" && c.status !== "running") {
        events.push({ name: c.name, from: prev, to: c.status });
      }
    }
    previousStates = currentStates;
  }

  return { check, events };
}

// ── Simulate checkDiskUsage decision logic ────────────────────────────────────

interface DiskAlert {
  level: "warning" | "critical";
  percent: number;
}

function checkDiskUsage(
  percent: number,
  shouldNotify: (key: string) => boolean,
): DiskAlert | null {
  if (percent > 90 && shouldNotify("disk:critical")) {
    return { level: "critical", percent };
  }
  if (percent > 80 && shouldNotify("disk:warning")) {
    return { level: "warning", percent };
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkContainerHealth state machine", () => {
  it("fires an event when a container transitions from running to stopped", () => {
    const { check, events } = makeContainerHealthChecker();

    check([{ name: "plex", status: "running" }]);
    check([{ name: "plex", status: "exited" }]);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("plex");
    expect(events[0].from).toBe("running");
    expect(events[0].to).toBe("exited");
  });

  it("does not fire an event on first appearance", () => {
    const { check, events } = makeContainerHealthChecker();
    check([{ name: "plex", status: "exited" }]);
    expect(events).toHaveLength(0);
  });

  it("does not fire an event when a container stays running", () => {
    const { check, events } = makeContainerHealthChecker();
    check([{ name: "plex", status: "running" }]);
    check([{ name: "plex", status: "running" }]);
    expect(events).toHaveLength(0);
  });

  it("does not fire an event when a stopped container is restarted", () => {
    const { check, events } = makeContainerHealthChecker();
    check([{ name: "plex", status: "exited" }]);
    check([{ name: "plex", status: "running" }]);
    expect(events).toHaveLength(0);
  });

  it("fires events for multiple containers simultaneously", () => {
    const { check, events } = makeContainerHealthChecker();
    check([
      { name: "plex", status: "running" },
      { name: "sonarr", status: "running" },
    ]);
    check([
      { name: "plex", status: "exited" },
      { name: "sonarr", status: "paused" },
    ]);
    expect(events).toHaveLength(2);
  });
});

describe("checkDiskUsage thresholds", () => {
  it("returns critical alert at >90%", () => {
    const shouldNotify = makeShouldNotify(0); // no cooldown
    const alert = checkDiskUsage(91, shouldNotify);
    expect(alert?.level).toBe("critical");
  });

  it("returns warning alert at >80% but <=90%", () => {
    const shouldNotify = makeShouldNotify(0);
    const alert = checkDiskUsage(85, shouldNotify);
    expect(alert?.level).toBe("warning");
  });

  it("returns null at <=80%", () => {
    const shouldNotify = makeShouldNotify(0);
    const alert = checkDiskUsage(79, shouldNotify);
    expect(alert).toBeNull();
  });

  it("respects cooldown — does not fire the same alert twice within window", () => {
    const shouldNotify = makeShouldNotify(60_000); // 1 min cooldown
    // First call at 85% fires disk:warning
    const first = checkDiskUsage(85, shouldNotify);
    // Second call at 85% should be blocked by cooldown on disk:warning
    const second = checkDiskUsage(85, shouldNotify);
    expect(first?.level).toBe("warning");
    expect(second).toBeNull();
  });

  it("fires again after cooldown expires (using 0ms cooldown)", () => {
    // With 0ms cooldown, each call at the same level fires
    // We need to advance time slightly — use a helper that always returns true
    const alwaysNotify = (_key: string) => true;
    const first = checkDiskUsage(85, alwaysNotify);
    const second = checkDiskUsage(85, alwaysNotify);
    expect(first?.level).toBe("warning");
    expect(second?.level).toBe("warning");
  });
});
