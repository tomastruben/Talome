/**
 * Minimal 5-field cron matching (minute hour day-of-month month day-of-week),
 * the same dialect the monitor's schedule runner accepts: "*", "*\/n", lists
 * and ranges.
 */

function fieldMatches(expr: string, value: number): boolean {
  if (expr === "*") return true;
  return expr.split(",").some((part) => {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;
    if (rangePart === "*") return value % step === 0;
    if (rangePart.includes("-")) {
      const [lo, hi] = rangePart.split("-").map(Number);
      return value >= lo && value <= hi && (value - lo) % step === 0;
    }
    return parseInt(rangePart, 10) === value;
  });
}

export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    fieldMatches(min, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(mon, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

/**
 * Longest gap between two consecutive runs over the next ~5 weeks, in ms.
 * Returns null when the expression never fires in that window.
 */
export function maxCronIntervalMs(cron: string, from: Date = new Date()): number | null {
  const start = new Date(from);
  start.setSeconds(0, 0);
  const horizonMinutes = 35 * 24 * 60;
  let previous: number | null = null;
  let maxGap = 0;
  for (let i = 0; i < horizonMinutes; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (!cronMatches(cron, t)) continue;
    if (previous !== null) maxGap = Math.max(maxGap, t.getTime() - previous);
    previous = t.getTime();
  }
  if (previous === null) return null;
  // A single match within the horizon (e.g. monthly) → assume ~31 days
  return maxGap > 0 ? maxGap : 31 * 24 * 60 * 60_000;
}
