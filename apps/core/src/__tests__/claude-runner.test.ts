import { beforeEach, describe, expect, it, vi } from "vitest";

const process = vi.hoisted(() => ({
  spawnProcess: vi.fn(), spawnClaudeStreaming: vi.fn(), getChangedFiles: vi.fn(),
  runTypecheck: vi.fn(), stashRollback: vi.fn(),
}));
vi.mock("../ai/claude-process.js", () => process);
// Importing the runner must not sweep the user's screenshot directory in a test.
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), readdir: vi.fn(async () => []),
}));
import { runClaudeCode } from "../ai/claude-runner.js";

beforeEach(() => vi.clearAllMocks());
describe("Claude execution outcome", () => {
  it("keeps failed execution failed even when partial output looks successful", async () => {
    process.spawnClaudeStreaming.mockResolvedValue({ code: 1, stdout: "Created part of the app", stderr: "Generation interrupted" });
    const result = await runClaudeCode({ task: "Build a test app", cwd: "/tmp/disposable-app", mode: "headless", runTypecheck: true });
    expect(result).toMatchObject({ success: false, output: "Created part of the app", error: "Generation interrupted" });
    expect(process.runTypecheck).not.toHaveBeenCalled();
    expect(process.stashRollback).not.toHaveBeenCalled();
  });
  it("reports a nonzero exit even without stderr", async () => {
    process.spawnClaudeStreaming.mockResolvedValue({ code: 2, stdout: "Partial output", stderr: "" });
    expect(await runClaudeCode({ task: "Build", cwd: "/tmp/disposable-app", mode: "headless" })).toMatchObject({ success: false, error: "Claude Code exited with code 2" });
  });
  it("preserves a successful execution and its changed-file inventory", async () => {
    process.spawnClaudeStreaming.mockResolvedValue({ code: 0, stdout: "Completed", stderr: "" });
    process.getChangedFiles.mockResolvedValue(["app.ts"]);
    expect(await runClaudeCode({ task: "Build", cwd: "/tmp/disposable-app", mode: "headless" })).toMatchObject({ success: true, output: "Completed", filesChanged: ["app.ts"] });
  });
});
