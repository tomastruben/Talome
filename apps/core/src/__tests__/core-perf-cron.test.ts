import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; trigger: string }>,
}));

vi.mock("../db/index.js", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    all: () => state.rows,
  };
  return {
    db: { select: () => chain },
    schema: { automations: { id: "id", trigger: "trigger", enabled: "enabled" } },
  };
});

const fireTrigger = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../automation/engine.js", () => ({ fireTrigger }));

import {
  runScheduleTick,
  getParsedSchedule,
  getScheduleCacheSize,
  clearScheduleCache,
  dueOccurrence,
} from "../automation/cron.js";

const schedule = (cron: string) => JSON.stringify({ type: "schedule", cron });

beforeEach(() => {
  clearScheduleCache();
  fireTrigger.mockClear();
  state.rows = [];
});

describe("parsed schedule cache", () => {
  it("reuses the compiled schedule while the trigger is unchanged", () => {
    const a = getParsedSchedule("auto-1", schedule("*/5 * * * *"));
    const b = getParsedSchedule("auto-1", schedule("*/5 * * * *"));
    expect(b).toBe(a);
    expect(a.cron).not.toBeNull();
  });

  it("recompiles when the trigger changes", () => {
    const a = getParsedSchedule("auto-1", schedule("*/5 * * * *"));
    const b = getParsedSchedule("auto-1", schedule("0 3 * * *"));
    expect(b).not.toBe(a);
    expect(b.pattern).toBe("0 3 * * *");
  });

  it("caches non-schedule and invalid triggers as inert entries", () => {
    expect(getParsedSchedule("x", JSON.stringify({ type: "container_stopped" })).cron).toBeNull();
    expect(getParsedSchedule("y", "{not json").cron).toBeNull();
    expect(getParsedSchedule("z", schedule("not a cron")).cron).toBeNull();
  });

  it("drops entries for automations that were deleted or disabled", async () => {
    state.rows = [
      { id: "a", trigger: schedule("0 3 * * *") },
      { id: "b", trigger: schedule("0 4 * * *") },
    ];
    await runScheduleTick(new Date("2026-09-28T10:00:00.010Z"));
    expect(getScheduleCacheSize()).toBe(2);

    state.rows = [{ id: "a", trigger: schedule("0 3 * * *") }];
    await runScheduleTick(new Date("2026-09-28T10:01:00.010Z"));
    expect(getScheduleCacheSize()).toBe(1);
  });
});

describe("schedule firing", () => {
  it("fires an automation whose occurrence fell in the current minute, exactly once", async () => {
    state.rows = [{ id: "every5", trigger: schedule("*/5 * * * *") }];

    await runScheduleTick(new Date("2026-09-28T10:05:00.020Z"));
    expect(fireTrigger).toHaveBeenCalledTimes(1);
    expect(fireTrigger).toHaveBeenCalledWith("schedule", { automationId: "every5", cron: "*/5 * * * *" });

    // A second tick inside the same minute must not re-fire the occurrence.
    await runScheduleTick(new Date("2026-09-28T10:05:30.000Z"));
    expect(fireTrigger).toHaveBeenCalledTimes(1);

    // Minutes that don't match the pattern don't fire.
    await runScheduleTick(new Date("2026-09-28T10:06:00.020Z"));
    expect(fireTrigger).toHaveBeenCalledTimes(1);

    await runScheduleTick(new Date("2026-09-28T10:10:00.020Z"));
    expect(fireTrigger).toHaveBeenCalledTimes(2);
  });

  it("evaluates schedules in UTC", () => {
    const entry = getParsedSchedule("daily", schedule("0 3 * * *"));
    expect(dueOccurrence(entry, new Date("2026-09-28T03:00:00.500Z"))?.toISOString()).toBe("2026-09-28T03:00:00.000Z");
    expect(dueOccurrence(entry, new Date("2026-09-28T04:00:00.500Z"))).toBeNull();
  });
});
