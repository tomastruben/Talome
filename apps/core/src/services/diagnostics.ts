import { getContainerLogs } from "../docker/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ErrorPattern {
  pattern: string;
  count: number;
  sample: string;
}

export interface JellyfinDiagnostics {
  errorPatterns: ErrorPattern[];
  lastUpdated: string;
  errorRate: string;
}

// ── Error pattern definitions ────────────────────────────────────────────────

const ERROR_CATEGORIES: { pattern: string; regex: RegExp }[] = [
  { pattern: "codec_error", regex: /codec|decode|encoder/i },
  { pattern: "network_error", regex: /connection|timeout|refused/i },
  { pattern: "memory_error", regex: /OOM|out of memory|memory/i },
  { pattern: "storage_error", regex: /ENOSPC|disk|no space/i },
];

// ── Cache ────────────────────────────────────────────────────────────────────

let cached: JellyfinDiagnostics | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Core detection logic ─────────────────────────────────────────────────────

export async function detectJellyfinErrors(): Promise<JellyfinDiagnostics> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  let logs: string;
  try {
    logs = await getContainerLogs("jellyfin-server-1", 500);
  } catch {
    return {
      errorPatterns: [],
      lastUpdated: new Date().toISOString(),
      errorRate: "0%",
    };
  }

  const lines = logs.split("\n").filter(Boolean);
  const totalLines = lines.length;

  // Track matches per category
  const counts = new Map<string, { count: number; sample: string }>();

  for (const line of lines) {
    for (const { pattern, regex } of ERROR_CATEGORIES) {
      if (regex.test(line)) {
        const existing = counts.get(pattern);
        if (existing) {
          existing.count++;
        } else {
          // Strip leading Docker timestamp for a cleaner sample
          const sample = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, "").slice(0, 120);
          counts.set(pattern, { count: 1, sample });
        }
      }
    }
  }

  // Sort by count descending, take top 3
  const errorPatterns: ErrorPattern[] = [...counts.entries()]
    .map(([pattern, { count, sample }]) => ({ pattern, count, sample }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const totalErrors = errorPatterns.reduce((sum, p) => sum + p.count, 0);
  const errorRate = totalLines > 0
    ? `${Math.round((totalErrors / totalLines) * 100)}%`
    : "0%";

  const result: JellyfinDiagnostics = {
    errorPatterns,
    lastUpdated: new Date().toISOString(),
    errorRate,
  };

  cached = result;
  cachedAt = now;

  return result;
}
