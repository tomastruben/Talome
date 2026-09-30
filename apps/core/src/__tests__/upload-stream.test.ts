import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated home (allowed root is ~/.talome) and database — set before imports.
// realpath: on macOS the temp dir is a symlink (/var → /private/var), and
// upload targets are returned with symlinks resolved.
const tempHome = realpathSync(mkdtempSync(join(tmpdir(), "talome-upload-")));
process.env.HOME = tempHome;
process.env.DATABASE_PATH = join(tempHome, "talome.db");
const root = join(tempHome, ".talome");
mkdirSync(join(root, "files"), { recursive: true });

let upload: typeof import("../utils/upload.js");

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
  upload = await import("../utils/upload.js");
});

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("resolveUploadTarget", () => {
  it("creates folders for folder uploads inside the target", async () => {
    const target = await upload.resolveUploadTarget(join(root, "files"), "Holiday/Day 1/beach.jpg");
    expect(target).toMatchObject({ ok: true, fileName: "beach.jpg", dir: join(root, "files", "Holiday", "Day 1") });
  });

  it.each(["../escape.txt", "a/../../escape.txt", ".hidden", "a/.git/config", "a\\b.txt", ""])("rejects %j", async (path) => {
    const target = await upload.resolveUploadTarget(join(root, "files"), path);
    expect(target.ok).toBe(false);
  });

  it("rejects targets outside the allowed roots, including through symlinks", async () => {
    expect((await upload.resolveUploadTarget("/etc", "x.txt")).ok).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), "talome-outside-"));
    symlinkSync(outside, join(root, "files", "link-out"));
    const target = await upload.resolveUploadTarget(join(root, "files"), "link-out/x.txt");
    expect(target.ok).toBe(false);
    // Nested folders under the symlink must not be created outside the root either
    const nested = await upload.resolveUploadTarget(join(root, "files"), "link-out/evil/deeper/x.txt");
    expect(nested.ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("streamUpload", () => {
  const dir = () => join(root, "files");

  it("streams the body to the destination and leaves no partial files", async () => {
    const result = await upload.streamUpload({ body: bodyOf("hello"), dir: dir(), fileName: "a.txt", conflict: "rename", expectedBytes: 5 });
    expect(result).toMatchObject({ ok: true, name: "a.txt", bytes: 5 });
    expect(readFileSync(join(dir(), "a.txt"), "utf8")).toBe("hello");
    expect(readdirSync(dir()).some((f) => f.endsWith(".talome-part"))).toBe(false);
  });

  it("keeps both files by default, replaces or skips on request", async () => {
    writeFileSync(join(dir(), "b.txt"), "old");
    const renamed = await upload.streamUpload({ body: bodyOf("new"), dir: dir(), fileName: "b.txt", conflict: "rename" });
    expect(renamed).toMatchObject({ ok: true, name: "b (1).txt" });
    expect(readFileSync(join(dir(), "b.txt"), "utf8")).toBe("old");

    const skipped = await upload.streamUpload({ body: bodyOf("x"), dir: dir(), fileName: "b.txt", conflict: "skip" });
    expect(skipped).toMatchObject({ ok: true, skipped: true });
    expect(readFileSync(join(dir(), "b.txt"), "utf8")).toBe("old");

    const replaced = await upload.streamUpload({ body: bodyOf("newer"), dir: dir(), fileName: "b.txt", conflict: "replace" });
    expect(replaced).toMatchObject({ ok: true, name: "b.txt" });
    expect(readFileSync(join(dir(), "b.txt"), "utf8")).toBe("newer");
  });

  it("rejects a body shorter than announced and does not touch the existing file", async () => {
    writeFileSync(join(dir(), "c.txt"), "keep me");
    const result = await upload.streamUpload({ body: bodyOf("abc"), dir: dir(), fileName: "c.txt", conflict: "replace", expectedBytes: 10 });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir(), "c.txt"), "utf8")).toBe("keep me");
    expect(readdirSync(dir()).some((f) => f.endsWith(".talome-part"))).toBe(false);
  });

  it("refuses uploads larger than the free space on the drive", async () => {
    const result = await upload.streamUpload({ body: bodyOf("x"), dir: dir(), fileName: "huge.bin", conflict: "rename", expectedBytes: Number.MAX_SAFE_INTEGER });
    expect(result).toMatchObject({ ok: false, status: 507 });
  });
});

describe("PUT /api/files/upload-stream", () => {
  it("uploads a body larger than the 5 MB JSON limit through the real route", async () => {
    const { Hono } = await import("hono");
    const { files } = await import("../routes/files.js");
    const app = new Hono();
    app.route("/api/files", files);

    const big = "x".repeat(6 * 1024 * 1024);
    const res = await app.request(
      `/api/files/upload-stream?dir=${encodeURIComponent(join(root, "files"))}&path=${encodeURIComponent("big/video.bin")}&size=${big.length}`,
      { method: "PUT", body: big, headers: { "Content-Type": "application/octet-stream" } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "video.bin", bytes: big.length });
    expect(readFileSync(join(root, "files", "big", "video.bin")).length).toBe(big.length);
  });
});
