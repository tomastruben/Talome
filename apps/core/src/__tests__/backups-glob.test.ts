import { describe, it, expect } from "vitest";
import { compileExcludePatterns, globToRegExp } from "../backup/glob.js";

describe("exclude patterns", () => {
  it("matches bare names at any depth", () => {
    const m = compileExcludePatterns(["cache", "*.log"]);
    expect(m("cache", true)).toBe(true);
    expect(m("a/b/cache", true)).toBe(true);
    expect(m("app.log", false)).toBe(true);
    expect(m("logs/x/app.log", false)).toBe(true);
    expect(m("config.xml", false)).toBe(false);
  });

  it("anchors patterns with a slash", () => {
    const m = compileExcludePatterns(["/tmp", "data/transcodes/*"]);
    expect(m("tmp", true)).toBe(true);
    expect(m("nested/tmp", true)).toBe(false);
    expect(m("data/transcodes/a.ts", false)).toBe(true);
    expect(m("data/transcodes", true)).toBe(false);
  });

  it("supports ** and directory-only patterns", () => {
    const m = compileExcludePatterns(["**/thumbs/**", "logs/"]);
    expect(m("a/thumbs/b/c.jpg", false)).toBe(true);
    expect(m("thumbs/c.jpg", false)).toBe(true);
    expect(m("logs", true)).toBe(true);
    expect(m("logs", false)).toBe(false);
  });

  it("also matches against the app-relative path (Umbrel backupIgnore style)", () => {
    const m = compileExcludePatterns(["data/storage/*"]);
    // file "foo.jpg" in a volume mounted from ${APP_DATA_DIR}/data/storage
    expect(m("foo.jpg", false, "data/storage/foo.jpg")).toBe(true);
    expect(m("foo.jpg", false, "data/other/foo.jpg")).toBe(false);
  });

  it("ignores comments, negations and empty patterns", () => {
    expect(globToRegExp("# comment")).toBeNull();
    expect(globToRegExp("!keep")).toBeNull();
    expect(globToRegExp("   ")).toBeNull();
    expect(compileExcludePatterns(["", "# x"]).patterns).toEqual([]);
  });

  it("escapes regex metacharacters", () => {
    const m = compileExcludePatterns(["file(1).txt", "a+b"]);
    expect(m("file(1).txt", false)).toBe(true);
    expect(m("fileX1).txt", false)).toBe(false);
    expect(m("a+b", false)).toBe(true);
    expect(m("aab", false)).toBe(false);
  });
});
