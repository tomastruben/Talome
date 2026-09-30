import type { CpuInfo } from "node:os";

type CpuSample = Pick<CpuInfo, "times">[];
function totals(cpus: CpuSample) {
  return cpus.reduce((result, cpu) => ({
    idle: result.idle + cpu.times.idle,
    total: result.total + Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
    cores: result.cores + 1,
  }), { idle: 0, total: 0, cores: 0 });
}

/** CPU counters are cumulative; usage must be measured between samples. */
export function createCpuUsageSampler(initial: CpuSample) {
  let previous = totals(initial);
  let lastUsage = 0;
  return (cpus: CpuSample): number => {
    const current = totals(cpus);
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    if (current.cores !== previous.cores || total < 0 || idle < 0 || idle > total) {
      previous = current;
      lastUsage = 0;
      return lastUsage;
    }
    if (total === 0) return lastUsage;
    previous = current;
    lastUsage = Math.round(Math.max(0, Math.min(1, 1 - idle / total)) * 1000) / 10;
    return lastUsage;
  };
}
