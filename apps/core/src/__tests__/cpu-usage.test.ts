import { describe, expect, it } from "vitest";
import { createCpuUsageSampler } from "../utils/cpu-usage.js";
const sample = (user: number, idle: number) => [{ times: { user, idle, sys: 0, nice: 0, irq: 0 } }];

describe("current host CPU usage", () => {
  it("measures the sampling interval rather than the lifetime average", () => {
    const read = createCpuUsageSampler(sample(100, 900));
    expect(read(sample(200, 1000))).toBe(50);
    expect(read(sample(200, 1100))).toBe(0);
    expect(read(sample(300, 1100))).toBe(100);
  });
  it("combines CPU time across cores", () => {
    const read = createCpuUsageSampler([...sample(100, 900), ...sample(100, 900)]);
    expect(read([...sample(200, 900), ...sample(100, 1000)])).toBe(50);
  });
  it("retains the last result for simultaneous reads and recovers from counter resets", () => {
    const read = createCpuUsageSampler(sample(100, 900));
    expect(read(sample(200, 1000))).toBe(50);
    expect(read(sample(200, 1000))).toBe(50);
    expect(read(sample(0, 0))).toBe(0);
    expect(read(sample(25, 75))).toBe(25);
  });
});
