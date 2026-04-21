import { describe, it, expect } from "vitest";

// Test the similarity function by extracting it from memories.ts
// We inline it here so it can be tested without DB dependencies.

function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    const lower = s.toLowerCase();
    for (let i = 0; i < lower.length - 1; i++) {
      const bg = lower.slice(i, i + 2);
      set.set(bg, (set.get(bg) ?? 0) + 1);
    }
    return set;
  };
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aMap) {
    const bCount = bMap.get(bg) ?? 0;
    intersection += Math.min(count, bCount);
  }
  const total = a.length - 1 + (b.length - 1);
  return total === 0 ? 1 : (2 * intersection) / total;
}

describe("similarity()", () => {
  it("returns 1 for identical strings", () => {
    expect(similarity("hello world", "hello world")).toBe(1);
  });

  it("returns 1 for identical strings case-insensitively", () => {
    expect(similarity("Hello World", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(similarity("abc", "xyz")).toBe(0);
  });

  it("returns a value between 0 and 1 for partial matches", () => {
    const s = similarity("User prefers Sonarr", "User prefers Radarr");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("returns high similarity for near-duplicate memories", () => {
    const s = similarity(
      "User prefers Sonarr for TV show downloads",
      "User prefers Sonarr for TV downloads",
    );
    expect(s).toBeGreaterThan(0.8);
  });

  it("returns 1 for single-character strings (edge case)", () => {
    // total = 0 → special case returns 1
    expect(similarity("a", "a")).toBe(1);
  });
});

describe("writeMemory deduplication logic", () => {
  it("skips writing when similarity exceeds 0.8", () => {
    const existing = ["User prefers Sonarr for TV show downloads"];
    const newContent = "User prefers Sonarr for TV downloads";
    const shouldSkip = existing.some((e) => similarity(newContent, e) > 0.8);
    expect(shouldSkip).toBe(true);
  });

  it("does not skip writing when similarity is below threshold", () => {
    const existing = ["Server hostname is homelab"];
    const newContent = "User watches mostly sci-fi";
    const shouldSkip = existing.some((e) => similarity(newContent, e) > 0.8);
    expect(shouldSkip).toBe(false);
  });
});
