import { describe, it, expect, vi } from "vitest";
import {
  computeCpuUsage,
  sampleCpuTimes,
  parseDfOutput,
  parseVmStat,
  parseNetstatIb,
  parseProcNetDev,
  execFileTracked,
  diskUsageFromStatfs,
  readDiskUsage,
} from "../platform/index.js";
import { createLimiter, createSkipIfRunning, mapWithConcurrency, settleWithin } from "../platform/concurrency.js";
import type os from "node:os";

function cpu(user: number, sys: number, idle: number): os.CpuInfo {
  return { model: "test", speed: 1, times: { user, nice: 0, sys, idle, irq: 0 } };
}

describe("CPU utilisation from deltas", () => {
  it("uses the delta between samples, not cumulative ticks since boot", () => {
    // Since boot the machine was 90% idle; in the last window it was 75% busy.
    const prev = sampleCpuTimes([cpu(500, 500, 9000), cpu(500, 500, 9000)]);
    const curr = sampleCpuTimes([cpu(800, 500 + 50, 9000 + 50), cpu(500 + 250, 500 + 50, 9000 + 50)]);
    // deltas: busy = 300+50 + 250+50 = 650, idle = 100, total = 750
    expect(computeCpuUsage(prev, curr)).toBe(86.7);
    // The old (cumulative) method would have reported ~10%.
    const cumulative = Math.round((1 - curr.idle / curr.total) * 1000) / 10;
    expect(cumulative).toBeLessThan(15);
  });

  it("reports 0 for a fully idle window and 100 for a fully busy one", () => {
    const base = { idle: 1000, total: 2000 };
    expect(computeCpuUsage(base, { idle: 1500, total: 2500 })).toBe(0);
    expect(computeCpuUsage(base, { idle: 1000, total: 2500 })).toBe(100);
  });

  it("returns null for unusable samples (no elapsed ticks, counter reset)", () => {
    const base = { idle: 1000, total: 2000 };
    expect(computeCpuUsage(base, base)).toBeNull();
    expect(computeCpuUsage(base, { idle: 10, total: 20 })).toBeNull();
  });

  it("sums all tick types across cores", () => {
    const s = sampleCpuTimes([cpu(1, 2, 3), cpu(4, 5, 6)]);
    expect(s).toEqual({ idle: 9, total: 21 });
  });
});

describe("platform output parsers", () => {
  it("parses df -Pk and skips pseudo/system mounts", () => {
    const out = [
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/disk3s1s1   971350180  10500000 400000000       3%    /",
      "devfs                  210       210         0     100%    /dev",
      "/dev/disk3s6     971350180   2097172 400000000       1%    /System/Volumes/VM",
      "//user@nas/Media 3906250000 2000000000 1906250000   52%    /Volumes/Media Hub",
      "tmpfs              1024000         0   1024000       0%    /run",
    ].join("\n");
    const mounts = parseDfOutput(out);
    expect(mounts.map((m) => m.mount)).toEqual(["/", "/Volumes/Media Hub"]);
    const root = mounts[0];
    expect(root.totalBytes).toBe(971350180 * 1024);
    expect(root.usedBytes).toBe((971350180 - 400000000) * 1024);
    expect(root.type).toBe("internal");
    expect(mounts[1].type).toBe("external");
  });

  it("parses vm_stat app memory", () => {
    const out = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                             100.",
      "Pages speculative:                         10.",
      "Pages wired down:                          50.",
      "Pages occupied by compressor:              40.",
    ].join("\n");
    expect(parseVmStat(out)).toBe(200 * 16384);
    expect(parseVmStat("garbage")).toBeNull();
  });

  it("parses netstat -ib for en0 link rows only", () => {
    const out = [
      "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
      "en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff  100     0     5000      50     0     7000     0",
      "en0        1500  fe80::1%en0 fe80::1            100     -     9999      50     -     9999     -",
      "lo0        16384 <Link#1>                       10     0     100       10     0     100      0",
    ].join("\n");
    expect(parseNetstatIb(out)).toEqual({ rx: 5000, tx: 7000 });
  });

  it("parses /proc/net/dev excluding loopback", () => {
    const out = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0",
      "  eth0: 2000 20 0 0 0 0 0 0 3000 30 0 0 0 0 0 0",
      "  wlan0: 500 5 0 0 0 0 0 0 700 7 0 0 0 0 0 0",
    ].join("\n");
    expect(parseProcNetDev(out)).toEqual({ rx: 2500, tx: 3700 });
  });
});

describe("root disk usage via statfs", () => {
  it("computes usage like parseDfOutput (used = total - available)", () => {
    // 1000 blocks of 4 KiB, 250 available to unprivileged users (root reserve excluded).
    expect(diskUsageFromStatfs({ bsize: 4096, blocks: 1000, bavail: 250 })).toEqual({
      usedBytes: 750 * 4096,
      totalBytes: 1000 * 4096,
      percent: 75,
    });
    expect(diskUsageFromStatfs({ bsize: 4096, blocks: 0, bavail: 0 })).toBeNull();
  });

  it("reads the root filesystem directly and resolves null instead of rejecting", async () => {
    const root = await readDiskUsage("/");
    expect(root?.totalBytes).toBeGreaterThan(0);
    expect(root?.percent).toBeGreaterThanOrEqual(0);
    expect(root?.percent).toBeLessThanOrEqual(100);
    expect(await readDiskUsage("/definitely/not/a/real/path")).toBeNull();
  });
});

describe("concurrency helpers", () => {
  it("createLimiter never runs more than max tasks at once and releases on failure", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = (fail: boolean) => limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      if (fail) throw new Error("boom");
      return 1;
    });
    const results = await Promise.allSettled([task(true), task(false), task(true), task(false), task(false)]);
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("mapWithConcurrency keeps input order and never rejects", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      if (n === 1) throw new Error("x");
      return n * 10;
    });
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : "err"))).toEqual([30, "err", 20]);
  });

  it("settleWithin resolves the fallback on timeout or rejection", async () => {
    expect(await settleWithin(new Promise(() => {}), 5, "late")).toBe("late");
    expect(await settleWithin(Promise.reject(new Error("x")), 50, "failed")).toBe("failed");
    expect(await settleWithin(Promise.resolve(7), 50, 0)).toBe(7);
  });
});

describe("limiter priority lane", () => {
  it("runs priority tasks before queued normal tasks", async () => {
    const limit = createLimiter(1);
    const order: string[] = [];
    let release!: () => void;
    const first = limit(() => new Promise<void>((r) => { release = r; }));
    const normal = limit(async () => { order.push("normal"); });
    const urgent = limit(async () => { order.push("urgent"); }, { priority: true });
    release();
    await Promise.all([first, normal, urgent]);
    expect(order).toEqual(["urgent", "normal"]);
  });
});

describe("createSkipIfRunning", () => {
  it("skips only the job that is still running", async () => {
    const guard = createSkipIfRunning({ abandonAfterMs: 60_000 });
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const fast = vi.fn(async () => {});

    void guard("slow", slow);
    await guard("fast", fast);
    void guard("slow", slow); // skipped: previous run pending
    await guard("fast", fast); // other jobs keep running
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(2);

    release();
    await new Promise((r) => setTimeout(r, 0));
    void guard("slow", slow);
    expect(slow).toHaveBeenCalledTimes(2);
    release();
  });

  it("abandons a run that never settles after abandonAfterMs", async () => {
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const onAbandon = vi.fn();
      const guard = createSkipIfRunning({ abandonAfterMs: 1_000, onAbandon });
      const hung = vi.fn(() => new Promise<void>(() => {}));
      void guard("hung", hung);
      now = 999;
      void guard("hung", hung);
      expect(hung).toHaveBeenCalledTimes(1);
      now = 1_000;
      void guard("hung", hung);
      expect(hung).toHaveBeenCalledTimes(2);
      expect(onAbandon).toHaveBeenCalledWith("hung");
    } finally {
      spy.mockRestore();
    }
  });

  it("never rejects, even when the job throws synchronously", async () => {
    const guard = createSkipIfRunning({ abandonAfterMs: 1_000 });
    await expect(guard("boom", () => { throw new Error("boom"); })).resolves.toBeUndefined();
    await expect(guard("boom", async () => { throw new Error("boom"); })).resolves.toBeUndefined();
  });
});

describe("execFileTracked", () => {
  it("returns stdout and reports the child's exit", async () => {
    const run = execFileTracked("/bin/echo", ["hello"], 2_000);
    expect(await run.output).toBe("hello\n");
    await expect(run.exited).resolves.toBeUndefined();
  });

  it("resolves null on timeout and SIGKILLs a child that ignores SIGTERM", async () => {
    const started = performance.now();
    const run = execFileTracked("/bin/sh", ["-c", "trap '' TERM; exec sleep 5"], 100);
    expect(await run.output).toBeNull();
    await run.exited;
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("reports a spawn failure as null output and an exited child", async () => {
    const run = execFileTracked("/definitely/not/a/binary", [], 1_000);
    expect(await run.output).toBeNull();
    await expect(run.exited).resolves.toBeUndefined();
  });
});
