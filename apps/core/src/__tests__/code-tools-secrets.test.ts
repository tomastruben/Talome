/**
 * read_file / list_directory are read tier (read-only MCP tokens, locked mode,
 * automations). They must never hand out apps/core/.env (TALOME_SECRET), the
 * SQLite database, keys or other secret files — directly, through a symlink,
 * or through a sibling folder that merely shares the workspace's name prefix.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const parent = `${base}/talome-code-tools-${process.pid}-${Date.now()}`;
  const root = `${parent}/server`;
  process.env.TALOME_ROOT = root;
  process.env.DATABASE_PATH = `${parent}/db/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
  process.env.TEST_CODE_TOOLS_API_TOKEN = "known-secret-7c1e9d44b2";
  return { parent, root };
});

vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));

import { readFileTool, listDirectoryTool, deniedCodePathReason } from "../ai/tools/code-tools.js";

type Exec = (args: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
const readFile = (path: string) => (readFileTool as unknown as { execute: Exec }).execute({ path }, { toolCallId: "t", messages: [] });
const listDir = (path: string, recursive = false) =>
  (listDirectoryTool as unknown as { execute: Exec }).execute({ path, recursive, maxDepth: 5 }, { toolCallId: "t", messages: [] });

const SECRET = "TALOME_SECRET=0123456789abcdef-secret-value";

beforeAll(() => {
  const { root, parent } = fx;
  mkdirSync(join(root, "apps/core/src"), { recursive: true });
  mkdirSync(join(root, "apps/core/data"), { recursive: true });
  mkdirSync(join(root, "keys"), { recursive: true });
  mkdirSync(join(parent, "db"), { recursive: true });
  writeFileSync(join(root, "apps/core/.env"), `${SECRET}\n`);
  writeFileSync(join(root, "apps/core/.env.local"), `${SECRET}\n`);
  writeFileSync(join(root, ".env.example"), "TALOME_SECRET=\n");
  writeFileSync(join(root, "apps/core/data/talome.db"), "SQLite format 3");
  writeFileSync(join(root, "apps/core/data/notes.txt"), SECRET);
  writeFileSync(join(root, "keys/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  writeFileSync(join(root, "keys/server.pem"), "-----BEGIN PRIVATE KEY-----");
  writeFileSync(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_secret");
  writeFileSync(join(root, "apps/core/src/index.ts"), 'export const ok = "hello";\nconst token = "known-secret-7c1e9d44b2";\n');
  // A symlink with an innocent name pointing at the secret file.
  symlinkSync(join(root, "apps/core/.env"), join(root, "apps/core/src/config.ts"));
  // A symlink leading out of the workspace.
  const outside = mkdtempSync(join(tmpdir(), "talome-outside-"));
  writeFileSync(join(outside, "passwd"), "root:x:0:0");
  symlinkSync(outside, join(root, "apps/core/src/outside"));
  // A sibling that shares the workspace's path prefix ("server" → "server-old").
  mkdirSync(join(parent, "server-old"), { recursive: true });
  writeFileSync(join(parent, "server-old/.hidden-copy"), SECRET);
});

afterAll(() => {
  rmSync(fx.parent, { recursive: true, force: true });
});

describe("read_file", () => {
  it("refuses .env files, databases, data/ and keys", async () => {
    for (const path of [
      "apps/core/.env",
      "apps/core/.ENV",
      "./apps/core/.env.local",
      "apps/core/src/../.env",
      "apps/core/data/talome.db",
      "apps/core/data/notes.txt",
      "keys/id_ed25519",
      "keys/server.pem",
      ".npmrc",
    ]) {
      const r = await readFile(path);
      expect(r.error, path).toMatch(/Access denied/);
      expect(JSON.stringify(r)).not.toContain("secret-value");
    }
  });

  it("refuses a symlink to a secret or out of the workspace", async () => {
    const viaLink = await readFile("apps/core/src/config.ts");
    expect(viaLink.error).toMatch(/Access denied/);
    expect(JSON.stringify(viaLink)).not.toContain("secret-value");

    const outside = await readFile("apps/core/src/outside/passwd");
    expect(outside.error).toMatch(/outside the Talome workspace/);
  });

  it("refuses a sibling folder that shares the workspace's name prefix", async () => {
    const r = await readFile("../server-old/.hidden-copy");
    expect(r.error).toMatch(/outside the Talome workspace/);
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("still reads source files and env templates, masking known secret values", async () => {
    const src = await readFile("apps/core/src/index.ts");
    expect(src.error).toBeUndefined();
    expect(String(src.content)).toContain('export const ok = "hello"');
    expect(String(src.content)).not.toContain("known-secret-7c1e9d44b2");

    const template = await readFile(".env.example");
    expect(template.error).toBeUndefined();
    expect(String(template.content)).toContain("TALOME_SECRET=");
  });
});

describe("list_directory", () => {
  it("omits secret files and data folders, and refuses to list them", async () => {
    const r = await listDir(".", true);
    const entries = r.entries as string[];
    expect(entries).toContain("apps/core/src/index.ts");
    expect(entries).toContain(".env.example");
    for (const hidden of ["apps/core/.env", "apps/core/.env.local", "apps/core/data/", "apps/core/data/talome.db", "keys/id_ed25519", "keys/server.pem", ".npmrc"]) {
      expect(entries, hidden).not.toContain(hidden);
    }
    expect((await listDir("apps/core/data")).error).toMatch(/Access denied/);
    expect((await listDir("../server-old")).error).toMatch(/outside the Talome workspace/);
    expect((await listDir("apps/core/src/outside")).error).toMatch(/outside the Talome workspace/);
  });
});

describe("deniedCodePathReason", () => {
  it("allows ordinary source paths", () => {
    for (const ok of ["apps/core/src/ai/agent.ts", "apps/dashboard/src/app/page.tsx", "README.md", ".env.example", "docs/environment.md", "apps/core/src/utils/env.ts"]) {
      expect(deniedCodePathReason(ok), ok).toBeNull();
    }
  });
});
