import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNativeBrowserHarness } from "../creator/browser-process.js";

async function fixture(code: string, run: (path: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "talome-browser-process-"));
  try {
    const path = join(root, "runner with spaces.mjs");
    await writeFile(path, code);
    await run(path, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("bounded native browser subprocess", () => {
  it("passes literal JSON through stdin and excludes core credentials from the runner", async () => {
    await fixture(`let text=''; for await (const chunk of process.stdin) text+=chunk; console.log(JSON.stringify({input:JSON.parse(text),secret:process.env.TALOME_SECRET??null,nodeOptions:process.env.NODE_OPTIONS??null}));`, async (path, root) => {
      const input = { value: "$(touch should-not-exist) `literal`\nquote'\"" };
      const output = JSON.parse(await runNativeBrowserHarness(path, input, root));
      expect(output).toEqual({ input, secret: null, nodeOptions: null });
    });
  });

  it("fails closed on missing tooling and runner crashes", async () => {
    await fixture(`console.error('Chromium executable is missing'); process.exit(7);`, async (path, root) => {
      await expect(runNativeBrowserHarness(path, {}, root)).rejects.toThrow(/Chromium executable is missing/);
      await expect(runNativeBrowserHarness(join(root, "missing.mjs"), {}, root)).rejects.toThrow();
    });
  });

  it("bounds excessive output", async () => {
    await fixture(`process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000);`, async (path, root) => {
      await expect(runNativeBrowserHarness(path, {}, root, { maxOutputBytes: 1024 })).rejects.toThrow(/output limit/);
    });
  });

  it("stops a hung runner and its child process at the deadline", async () => {
    await fixture(`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync('child.pid',String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`, async (path, root) => {
      await expect(runNativeBrowserHarness(path, {}, root, { timeoutMs: 500 })).rejects.toThrow(/timed out/);
      const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
      await expect.poll(() => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      }, { timeout: 3000 }).toBe(false);
    });
  });
});
