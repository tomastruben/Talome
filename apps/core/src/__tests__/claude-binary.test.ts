import { describe, expect, it } from "vitest";
import { resolveClaudeBinary } from "../ai/claude-binary.js";

const HOME = "/Users/example";

describe("resolveClaudeBinary", () => {
  it("prefers a claude found on PATH", () => {
    const found = resolveClaudeBinary({
      path: "/usr/local/bin:/opt/homebrew/bin",
      home: HOME,
      isExecutable: (candidate) => candidate === "/opt/homebrew/bin/claude",
    });
    expect(found).toBe("/opt/homebrew/bin/claude");
  });

  it("falls back to the native installer location when PATH omits ~/.local/bin", () => {
    const found = resolveClaudeBinary({
      path: "/usr/local/bin:/usr/bin:/bin",
      home: HOME,
      isExecutable: (candidate) => candidate === `${HOME}/.local/bin/claude`,
    });
    expect(found).toBe(`${HOME}/.local/bin/claude`);
  });

  it("returns the bare name when nothing is executable so callers keep their not-found handling", () => {
    expect(resolveClaudeBinary({ path: "/usr/bin", home: HOME, isExecutable: () => false })).toBe("claude");
  });

  it("ignores empty PATH segments", () => {
    const probed: string[] = [];
    resolveClaudeBinary({ path: ":/usr/bin::", home: HOME, isExecutable: (c) => { probed.push(c); return false; } });
    expect(probed[0]).toBe("/usr/bin/claude");
    expect(probed.every((c) => !c.startsWith("/claude"))).toBe(true);
  });
});
