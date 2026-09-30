/**
 * File manager writes never replace or silently skip: "New" on an existing
 * folder name is a 409 (it used to be a silent success), and rename/move
 * refuse to overwrite an item that is already there. Real temp filesystem.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-files-route-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(tmp.dir, "db"), { recursive: true });
const { runMigrations } = await import("../db/migrate.js");
const { TALOME_FILES_HOME } = await import("../utils/filesystem.js");
const { files } = await import("../routes/files.js");

const root = TALOME_FILES_HOME;
const post = (path: string, body: unknown) =>
  files.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

describe("POST /mkdir", () => {
  it("creates a new folder", async () => {
    const res = await post("/mkdir", { path: join(root, "New Folder") });
    expect(res.status).toBe(200);
    expect(existsSync(join(root, "New Folder"))).toBe(true);
  });

  it("answers 409 when the folder already exists (regression: silent no-op)", async () => {
    mkdirSync(join(root, "New Folder"));
    const res = await post("/mkdir", { path: join(root, "New Folder") });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/already exists/);
  });
});

describe("POST /rename", () => {
  it("refuses to overwrite an existing file", async () => {
    writeFileSync(join(root, "a.txt"), "A");
    writeFileSync(join(root, "b.txt"), "B");
    const res = await post("/rename", { oldPath: join(root, "a.txt"), newName: "b.txt" });
    expect(res.status).toBe(409);
    expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("B");
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("A");
  });

  it("renames when the name is free", async () => {
    writeFileSync(join(root, "a.txt"), "A");
    const res = await post("/rename", { oldPath: join(root, "a.txt"), newName: "c.txt" });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "c.txt"), "utf-8")).toBe("A");
  });
});

describe("POST /move", () => {
  it("skips an item whose name is taken at the destination instead of replacing it", async () => {
    mkdirSync(join(root, "dest"));
    writeFileSync(join(root, "dest", "report.txt"), "old");
    writeFileSync(join(root, "report.txt"), "new");
    writeFileSync(join(root, "other.txt"), "other");
    const res = await post("/move", { sources: [join(root, "report.txt"), join(root, "other.txt")], destination: join(root, "dest") });
    const body = (await res.json()) as { moved: string[]; errors?: Array<{ error: string }> };
    expect(body.moved).toHaveLength(1);
    expect(body.errors?.[0].error).toMatch(/already exists/);
    expect(readFileSync(join(root, "dest", "report.txt"), "utf-8")).toBe("old");
    expect(readFileSync(join(root, "report.txt"), "utf-8")).toBe("new");
    expect(readFileSync(join(root, "dest", "other.txt"), "utf-8")).toBe("other");
  });
});

describe("GET /list", () => {
  it("answers 404 with a plain reason for a folder that no longer exists", async () => {
    const res = await files.request(`/list?path=${encodeURIComponent(join(root, "gone"))}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/doesn't exist/);
  });

  it("answers 400 for a file path", async () => {
    writeFileSync(join(root, "note.txt"), "x");
    const res = await files.request(`/list?path=${encodeURIComponent(join(root, "note.txt"))}`);
    expect(res.status).toBe(400);
  });
});
