import { describe, it, expect } from "vitest";
import { applyRetentionPolicy, weekKey } from "../backup/retention.js";
import { maxCronIntervalMs, cronMatches } from "../backup/cron.js";

function daily(count: number, from = new Date(2026, 5, 30, 2, 0)) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() - i);
    return { id: `b${i}`, createdAt: d.toISOString() };
  });
}

describe("retention", () => {
  it("keeps everything without a policy", () => {
    const r = applyRetentionPolicy(daily(5), {});
    expect(r.prune).toEqual([]);
  });

  it("keeps the last N", () => {
    const r = applyRetentionPolicy(daily(10), { keepLast: 3 });
    expect(r.keep).toEqual(["b0", "b1", "b2"]);
    expect(r.prune).toHaveLength(7);
  });

  it("applies daily / weekly / monthly buckets (GFS)", () => {
    const backups = daily(120); // one backup per day for ~4 months
    const r = applyRetentionPolicy(backups, { keepDaily: 7, keepWeekly: 4, keepMonthly: 3 });
    // 7 dailies + weeklies/monthlies that overlap partly with the dailies
    const kept = new Set(r.keep);
    for (let i = 0; i < 7; i++) expect(kept.has(`b${i}`)).toBe(true);
    expect(kept.has("b119")).toBe(false);
    // at most 7 + 4 + 3 distinct backups, at least 7 + 3 (weeks/months overlap)
    expect(r.keep.length).toBeLessThanOrEqual(14);
    expect(r.keep.length).toBeGreaterThanOrEqual(10);
    // the kept weekly backups fall in distinct ISO weeks
    const weekly = r.keep.filter((id) => r.reasons[id].some((x) => x.startsWith("weekly")));
    const weeks = new Set(weekly.map((id) => weekKey(new Date(backups.find((b) => b.id === id)!.createdAt))));
    expect(weeks.size).toBe(4);
  });

  it("keeps the newest in each bucket when there are several per day", () => {
    const base = new Date(2026, 0, 10, 1, 0);
    const list = [0, 1, 2].map((h) => ({ id: `h${h}`, createdAt: new Date(base.getTime() + h * 3600_000).toISOString() }));
    const r = applyRetentionPolicy(list, { keepDaily: 1 });
    expect(r.keep).toEqual(["h2"]);
  });

  it("falls back to max age when no counts are set, always keeping the newest", () => {
    const now = new Date(2026, 5, 30, 12, 0);
    const r = applyRetentionPolicy(daily(40, new Date(2026, 5, 30, 2, 0)), { maxAgeDays: 30 }, now);
    expect(r.keep.length).toBe(30);
    const old = [{ id: "ancient", createdAt: new Date(2020, 0, 1).toISOString() }];
    expect(applyRetentionPolicy(old, { maxAgeDays: 30 }, now).keep).toEqual(["ancient"]);
  });

  it("never prunes the newest verified backup", () => {
    const list = daily(5).map((b, i) => ({ ...b, verified: i === 4 }));
    const r = applyRetentionPolicy(list, { keepLast: 2 });
    expect(r.keep).toContain("b4");
    expect(r.keep).toContain("b0");
    expect(r.prune).toEqual(["b2", "b3"]);
  });
});

describe("cron helpers", () => {
  it("matches steps, lists and ranges", () => {
    const d = new Date(2026, 0, 5, 2, 30); // Monday
    expect(cronMatches("30 2 * * *", d)).toBe(true);
    expect(cronMatches("*/15 * * * *", d)).toBe(true);
    expect(cronMatches("0 2 * * *", d)).toBe(false);
    expect(cronMatches("30 1-3 * * 1", d)).toBe(true);
    expect(cronMatches("30 2 * * 0,6", d)).toBe(false);
    // steps on ranges and on a start value (what schedule validation accepts)
    expect(cronMatches("0-30/5 * * * *", d)).toBe(true);
    expect(cronMatches("0-30/7 * * * *", d)).toBe(false);
    expect(cronMatches("10/10 * * * *", d)).toBe(true);
    expect(cronMatches("5/10 * * * *", d)).toBe(false);
  });

  it("estimates the interval between runs", () => {
    const from = new Date(2026, 0, 1, 0, 0);
    expect(maxCronIntervalMs("0 2 * * *", from)).toBe(24 * 3600_000);
    expect(maxCronIntervalMs("0 */6 * * *", from)).toBe(6 * 3600_000);
    expect(maxCronIntervalMs("0 2 * * 0", from)).toBe(7 * 24 * 3600_000);
  });
});
