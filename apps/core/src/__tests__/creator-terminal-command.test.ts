import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCreatorTerminalCommand } from "../creator/terminal-command.js";

describe("creator terminal launch", () => {
  it("opens paths with spaces and apostrophes and passes prompt text literally", async () => {
    const root = await mkdtemp(join(tmpdir(), "talome-command-"));
    try {
      const workspace = join(root, "Media Hub's app $(false)");
      const bin = join(root, "bin");
      await mkdir(workspace);
      await mkdir(bin);
      const fakeClaude = join(bin, "claude");
      await writeFile(fakeClaude, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n');
      await chmod(fakeClaude, 0o700);
      const promptFile = join(root, "prompt's text.md");
      const prompt = "Build this app. Literal $(false), `false`, and 'quoted words'.";
      await writeFile(promptFile, prompt);
      const result = await promisify(execFile)("/bin/sh", ["-c", buildCreatorTerminalCommand(workspace, promptFile, false)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.stdout).toBe(`${workspace}\n${prompt}\n`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
