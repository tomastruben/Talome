import { describe, it, expect } from "vitest";
import { relativeTime } from "@/lib/format";

describe("relativeTime", () => {
  it('returns "just now" for timestamps less than 60 seconds ago', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(iso)).toBe("just now");
  });

  it("returns minutes ago for timestamps 1–59 minutes old", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(iso)).toBe("5 min ago");
  });

  it("returns hours ago for timestamps 1–23 hours old", () => {
    const iso = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(relativeTime(iso)).toBe("3 hr ago");
  });

  it("returns days ago for timestamps 1+ day old", () => {
    const iso = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(relativeTime(iso)).toBe("2d ago");
  });

  it('returns "just now" for future timestamps (negative diff)', () => {
    const iso = new Date(Date.now() + 5000).toISOString();
    expect(relativeTime(iso)).toBe("just now");
  });

  it("returns exactly 1 min ago at the 60s boundary", () => {
    const iso = new Date(Date.now() - 60_000).toISOString();
    expect(relativeTime(iso)).toBe("1 min ago");
  });
});
