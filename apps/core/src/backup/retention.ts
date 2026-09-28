/**
 * Retention: "keep last N" plus grandfather-father-son (daily / weekly /
 * monthly) buckets, restic-style. A backup is kept if ANY rule keeps it.
 *
 *  - keepLast N    → the N newest backups
 *  - keepDaily N   → the newest backup of each of the N most recent days that have one
 *  - keepWeekly N  → same per ISO week
 *  - keepMonthly N → same per calendar month
 *  - maxAgeDays    → only when no keep* count is set: everything newer than the cutoff
 *
 * Safety rails: the newest backup is always kept, and so is the newest
 * *verified* backup, so a run of corrupt backups can never prune the last
 * known-good one.
 */

import type { RetentionPolicy } from "./types.js";

export interface RetentionCandidate {
  id: string;
  /** ISO timestamp the backup completed (or started) */
  createdAt: string;
  verified?: boolean;
}

export interface RetentionDecision {
  keep: string[];
  prune: string[];
  reasons: Record<string, string[]>;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** ISO-8601 week key, e.g. 2026-W05 (local time). */
export function weekKey(d: Date): string {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7; // Monday = 0
  date.setDate(date.getDate() - day + 3); // Thursday of this week
  const isoYear = date.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${pad(week)}`;
}

function positive(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function hasGfsRules(policy: RetentionPolicy): boolean {
  return positive(policy.keepLast) + positive(policy.keepDaily) + positive(policy.keepWeekly) + positive(policy.keepMonthly) > 0;
}

export function applyRetentionPolicy(
  candidates: RetentionCandidate[],
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionDecision {
  const sorted = [...candidates].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const reasons: Record<string, string[]> = {};
  const mark = (id: string, reason: string) => {
    (reasons[id] ??= []).push(reason);
  };

  const gfs = hasGfsRules(policy);
  const maxAge = positive(policy.maxAgeDays);
  if (!gfs && maxAge === 0) {
    // No policy → keep everything
    for (const c of sorted) mark(c.id, "no retention policy");
    return { keep: sorted.map((c) => c.id), prune: [], reasons };
  }

  if (sorted.length > 0) mark(sorted[0].id, "newest");
  const newestVerified = sorted.find((c) => c.verified);
  if (newestVerified) mark(newestVerified.id, "newest verified");

  if (gfs) {
    const last = positive(policy.keepLast);
    sorted.slice(0, last).forEach((c, i) => mark(c.id, `last ${i + 1}/${last}`));

    const bucket = (count: number, keyOf: (d: Date) => string, label: string) => {
      if (count === 0) return;
      const seen = new Set<string>();
      for (const c of sorted) {
        const key = keyOf(new Date(c.createdAt));
        if (seen.has(key)) continue;
        seen.add(key);
        mark(c.id, `${label} ${key}`);
        if (seen.size >= count) break;
      }
    };
    bucket(positive(policy.keepDaily), dayKey, "daily");
    bucket(positive(policy.keepWeekly), weekKey, "weekly");
    bucket(positive(policy.keepMonthly), monthKey, "monthly");
  } else {
    const cutoff = now.getTime() - maxAge * 86_400_000;
    for (const c of sorted) {
      if (Date.parse(c.createdAt) >= cutoff) mark(c.id, `within ${maxAge} days`);
    }
  }

  const keep: string[] = [];
  const prune: string[] = [];
  for (const c of sorted) (reasons[c.id] ? keep : prune).push(c.id);
  return { keep, prune, reasons };
}
