// ── Known-Good State Tracking ────────────────────────────────────────────────
//
// Uses lightweight git tags to mark stable states. When all processes have been
// healthy for a sustained period, we tag the current commit. On severe crash
// loops, we can revert to the last known-good tag.
//
// Only active when .git exists (bare metal / dev). In Docker production, the
// image IS the known-good state — no git operations needed.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TAG_PREFIX = "talome-known-good-";
const MAX_TAGS = 10;

// ── Git detection ────────────────────────────────────────────────────────────

export function isGitAvailable(projectRoot: string): boolean {
  return existsSync(join(projectRoot, ".git"));
}

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd, timeout: 10_000 }).trim();
}

function gitExecSafe(cmd: string, cwd: string): string | null {
  try {
    return gitExec(cmd, cwd);
  } catch {
    return null;
  }
}

// ── Tag management ───────────────────────────────────────────────────────────

export function recordKnownGood(projectRoot: string): string | null {
  if (!isGitAvailable(projectRoot)) return null;

  try {
    const commit = gitExec("git rev-parse --short HEAD", projectRoot);
    const tag = `${TAG_PREFIX}${Date.now()}`;
    gitExec(`git tag ${tag}`, projectRoot);
    console.log(`[supervisor] Tagged known-good state: ${tag} (${commit})`);

    // Prune old tags
    pruneKnownGoodTags(projectRoot);

    return tag;
  } catch (err) {
    console.error("[supervisor] Failed to tag known-good state:", err);
    return null;
  }
}

export function getLastKnownGood(projectRoot: string): string | null {
  if (!isGitAvailable(projectRoot)) return null;

  try {
    const tags = gitExec(
      `git tag -l '${TAG_PREFIX}*' --sort=-creatordate`,
      projectRoot,
    );
    if (!tags) return null;
    return tags.split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

export function getKnownGoodCommit(projectRoot: string, tag: string): string | null {
  return gitExecSafe(`git rev-parse ${tag}`, projectRoot);
}

/** Stash current changes and checkout the known-good tag's files. */
export function revertToKnownGood(projectRoot: string, tag: string): boolean {
  if (!isGitAvailable(projectRoot)) return false;

  try {
    // Check if there are uncommitted changes to stash
    const status = gitExec("git status --porcelain", projectRoot);
    let stashRef: string | null = null;

    if (status) {
      const stashMsg = `supervisor-revert-${Date.now()}`;
      gitExec(`git stash push -u -m "${stashMsg}"`, projectRoot);
      stashRef = stashMsg;
      console.log(`[supervisor] Stashed current changes: ${stashMsg}`);
    }

    // Checkout the known-good state
    const commit = getKnownGoodCommit(projectRoot, tag);
    if (!commit) {
      console.error(`[supervisor] Could not resolve tag ${tag}`);
      if (stashRef) gitExecSafe("git stash pop", projectRoot);
      return false;
    }

    // Safety: never check out a tag that's behind HEAD — that would overwrite
    // committed improvements. Only revert if tag == HEAD (stash is the fix)
    // or tag is ahead of HEAD (shouldn't happen but safe).
    const headCommit = gitExec("git rev-parse HEAD", projectRoot).trim();
    const tagCommit = gitExec(`git rev-parse ${tag}`, projectRoot).trim();
    if (headCommit !== tagCommit) {
      console.log(`[supervisor] Known-good tag ${tag} (${tagCommit.slice(0, 8)}) differs from HEAD (${headCommit.slice(0, 8)}) — skipping file checkout to protect committed code`);
      // Stashing already happened above, which handles uncommitted changes.
      // Don't overwrite committed files — that destroys intentional improvements.
      return !!stashRef; // Success if we at least stashed something
    }

    gitExec(`git checkout ${tag} -- .`, projectRoot);
    console.log(`[supervisor] Reverted to known-good: ${tag} (${commit})`);
    return true;
  } catch (err) {
    console.error("[supervisor] Failed to revert to known-good:", err);
    return false;
  }
}

/** Stash uncommitted changes (evolution revert without a known-good tag). */
export function stashUncommittedChanges(projectRoot: string): string | null {
  if (!isGitAvailable(projectRoot)) return null;

  try {
    const status = gitExec("git status --porcelain", projectRoot);
    if (!status) return null;

    const stashMsg = `supervisor-evolution-revert-${Date.now()}`;
    gitExec(`git stash push -u -m "${stashMsg}"`, projectRoot);
    console.log(`[supervisor] Stashed evolution changes: ${stashMsg}`);
    return stashMsg;
  } catch (err) {
    console.error("[supervisor] Failed to stash changes:", err);
    return null;
  }
}

function pruneKnownGoodTags(projectRoot: string): void {
  try {
    const tags = gitExec(
      `git tag -l '${TAG_PREFIX}*' --sort=-creatordate`,
      projectRoot,
    );
    if (!tags) return;

    const tagList = tags.split("\n").filter(Boolean);
    if (tagList.length <= MAX_TAGS) return;

    const toDelete = tagList.slice(MAX_TAGS);
    for (const tag of toDelete) {
      gitExecSafe(`git tag -d ${tag}`, projectRoot);
    }
    console.log(`[supervisor] Pruned ${toDelete.length} old known-good tags`);
  } catch {
    // Non-fatal
  }
}
