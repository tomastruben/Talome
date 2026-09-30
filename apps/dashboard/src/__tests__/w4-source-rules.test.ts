/**
 * Source-level guards for the lifecycle and data surfaces (W4): no native
 * dialogs (use useConfirm), and no white text below /70 on the always-black
 * video player (the "Preparing" and Cancel text were /25 and /15).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const OWNED = [
  "app/dashboard/apps",
  "app/dashboard/files",
  "app/dashboard/backups",
  "app/dashboard/storage",
  "app/dashboard/share",
  "app/dashboard/media",
  "app/dashboard/audiobooks",
  "components/app-detail",
  "components/files",
  "components/quick-look",
  "components/media",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("W4 source rules", () => {
  it("uses no native confirm/prompt/alert dialogs (regression: audiobook removal)", () => {
    const offenders: string[] = [];
    for (const dir of OWNED) {
      for (const file of sourceFiles(join(SRC, dir))) {
        const text = readFileSync(file, "utf-8");
        // A native dialog is called with a string; useConfirm() takes an object.
        if (/\b(?:window\.)?(?:confirm|prompt|alert)\(\s*["'`]/.test(text)) offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps video player status text readable on black", () => {
    const text = readFileSync(join(SRC, "components/files/media-player.tsx"), "utf-8");
    // The "Preparing…" line, its Cancel and the failure copy were /25, /15 and /25.
    expect(text).toMatch(/<p className="text-sm text-white\/70" role="status">/);
    expect(text).not.toMatch(/text-sm text-white\/25/);
    expect(text).not.toMatch(/text-xs text-white\/15/);
    expect(text).not.toMatch(/text-white\/25 mt-1\.5/);
  });
});
