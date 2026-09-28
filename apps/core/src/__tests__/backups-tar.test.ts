import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TarGzWriter, extractTarGz, readTarGz, encodeHeader, TarFormatError } from "../backup/tar.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talome-tar-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function buildSample(): Promise<{ archive: string; files: Array<{ name: string; sha256: string; size: number }> }> {
  const src = join(dir, "src");
  const longName = "a-very-long-directory-name-that-goes-on-and-on/".repeat(3) + "file-with-unicode-ünï.txt";
  mkdirSync(join(src, "sub"), { recursive: true });
  mkdirSync(join(src, longName, ".."), { recursive: true });
  writeFileSync(join(src, "hello.txt"), "hello world\n");
  writeFileSync(join(src, "sub", "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 254]));
  writeFileSync(join(src, "empty"), "");
  writeFileSync(join(src, longName), "long");
  writeFileSync(join(src, "big.bin"), Buffer.alloc(300_000, 7));
  symlinkSync("hello.txt", join(src, "link"));
  const archive = join(dir, "out.tar.gz");
  const w = new TarGzWriter(archive);
  const files: Array<{ name: string; sha256: string; size: number }> = [];
  await w.addTree(src, "volumes/0-src", { onFile: (f) => files.push({ name: f.name, sha256: f.sha256, size: f.size }) });
  await w.addBuffer("meta/info.json", Buffer.from("{}"));
  await w.close();
  return { archive, files };
}

describe("TarGzWriter / extractTarGz", () => {
  it("round-trips files, directories, symlinks and long unicode names", async () => {
    const { archive, files } = await buildSample();
    expect(files.length).toBe(5);
    const out = join(dir, "out");
    const extracted: string[] = [];
    await extractTarGz(archive, out, { onFile: (f) => extracted.push(f.name) });
    expect(readFileSync(join(out, "volumes/0-src/hello.txt"), "utf-8")).toBe("hello world\n");
    expect(readFileSync(join(out, "volumes/0-src/sub/binary.bin"))).toEqual(Buffer.from([0, 1, 2, 3, 255, 254]));
    expect(readFileSync(join(out, "volumes/0-src/empty")).length).toBe(0);
    expect(readFileSync(join(out, "volumes/0-src/big.bin")).length).toBe(300_000);
    expect(lstatSync(join(out, "volumes/0-src/link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, "volumes/0-src/link"))).toBe("hello.txt");
    const long = files.find((f) => f.name.includes("ünï"))!;
    expect(readFileSync(join(out, long.name), "utf-8")).toBe("long");
    expect(extracted).toContain("meta/info.json");
    for (const f of files) expect(sha(readFileSync(join(out, f.name)))).toBe(f.sha256);
  });

  it("produces archives that the system tar can list", async () => {
    const { archive } = await buildSample();
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf-8" });
    expect(listing).toContain("volumes/0-src/hello.txt");
    expect(listing).toContain("/file-with-unicode-");
  });

  it("reads archives produced by the system tar", async () => {
    const src = join(dir, "sys");
    mkdirSync(join(src, "d"), { recursive: true });
    writeFileSync(join(src, "d", "x.txt"), "from system tar");
    const archive = join(dir, "sys.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "d"]);
    const names: string[] = [];
    await readTarGz(archive, async (h, body) => {
      names.push(h.name);
      for await (const _ of body) {
        // drain
      }
    });
    expect(names).toContain("d/x.txt");
  });

  it("detects a corrupted archive", async () => {
    const { archive } = await buildSample();
    const buf = readFileSync(archive);
    // Flip bytes in the middle of the compressed stream
    for (let i = Math.floor(buf.length / 2); i < Math.floor(buf.length / 2) + 16; i++) buf[i] ^= 0xff;
    const bad = join(dir, "bad.tar.gz");
    writeFileSync(bad, buf);
    await expect(extractTarGz(bad, join(dir, "bad-out"))).rejects.toThrow();
  });

  it("detects a truncated archive", async () => {
    const { archive } = await buildSample();
    const raw = gunzipSync(readFileSync(archive));
    const truncated = join(dir, "trunc.tar.gz");
    writeFileSync(truncated, gzipSync(raw.subarray(0, 2048)));
    await expect(extractTarGz(truncated, join(dir, "trunc-out"))).rejects.toThrow(TarFormatError);
  });

  it("rejects path traversal entries", async () => {
    const evil = Buffer.concat([
      encodeHeader({ name: "../escape.txt", type: "file", mode: 0o644, uid: 0, gid: 0, size: 4, mtime: 0, linkname: "" }),
      Buffer.from("evil"),
      Buffer.alloc(508),
      Buffer.alloc(1024),
    ]);
    const archive = join(dir, "evil.tar.gz");
    writeFileSync(archive, gzipSync(evil));
    await expect(extractTarGz(archive, join(dir, "evil-out"))).rejects.toThrow(/Unsafe/);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
  });

  it("refuses to write through a symlink created by the archive", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const entries = Buffer.concat([
      encodeHeader({ name: "link", type: "symlink", mode: 0o777, uid: 0, gid: 0, size: 0, mtime: 0, linkname: outside }),
      encodeHeader({ name: "link/pwned.txt", type: "file", mode: 0o644, uid: 0, gid: 0, size: 4, mtime: 0, linkname: "" }),
      Buffer.from("evil"),
      Buffer.alloc(508),
      Buffer.alloc(1024),
    ]);
    const archive = join(dir, "link.tar.gz");
    writeFileSync(archive, gzipSync(entries));
    await expect(extractTarGz(archive, join(dir, "link-out"))).rejects.toThrow(/symlink/);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  it("records the size at lstat time when a file shrinks while archiving", async () => {
    const f = join(dir, "shrink.txt");
    writeFileSync(f, "0123456789");
    const st = await lstat(f);
    writeFileSync(f, "01234");
    const archive = join(dir, "shrink.tar.gz");
    const w = new TarGzWriter(archive);
    const added = await w.addFile("shrink.txt", f, st);
    await w.close();
    expect(added.changed).toBe(true);
    expect(added.size).toBe(10);
    const out = join(dir, "shrink-out");
    await extractTarGz(archive, out);
    expect(sha(readFileSync(join(out, "shrink.txt")))).toBe(added.sha256);
  });
});
