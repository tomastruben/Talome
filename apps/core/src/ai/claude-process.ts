/**
 * Shared Claude Code process utilities.
 *
 * Extracted from claude-runner.ts and evolution-worker.ts to eliminate
 * duplication. Both modules import from here.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Process helpers ────────────────────────────────────────────────────────────

// ── Claude Code detection ─────────────────────────────────────────────────────

let _claudeAvailable: boolean | null = null;
let _claudeVersion: string | null = null;

/**
 * Check if `claude` CLI is installed and reachable.
 * Result is cached for the process lifetime.
 */
export async function isClaudeCodeAvailable(): Promise<boolean> {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      let stdout = "";
      const proc = spawn("claude", ["--version"], { shell: false });
      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
      const p = proc as any;
      p.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout }));
      p.on("error", () => resolve({ code: 1, stdout: "" }));
    });
    _claudeAvailable = result.code === 0 && result.stdout.trim().length > 0;
    if (_claudeAvailable) _claudeVersion = result.stdout.trim().split("\n")[0];
  } catch {
    _claudeAvailable = false;
  }
  return _claudeAvailable;
}

/** Returns the cached Claude Code version string, or null if unavailable. */
export function getClaudeCodeVersion(): string | null {
  return _claudeVersion;
}

/** Reset detection cache (useful after install/update). */
export function resetClaudeCodeCache(): void {
  _claudeAvailable = null;
  _claudeVersion = null;
}

export function spawnProcess(
  cmd: string,
  args: string[],
  cwd: string,
  onData?: (chunk: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    // Strip CLAUDECODE to prevent nested-session detection when spawning claude
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { CLAUDECODE: _stripClaude, ...spawnEnv } = process.env;
    const proc = spawn(cmd, args, { cwd, env: spawnEnv, shell: false });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onData?.(text);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
    const p2 = proc as any;
    p2.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
    p2.on("error", (err: Error) =>
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() }),
    );
  });
}

/**
 * Spawn Claude Code with stream-json I/O so we get real-time output chunks.
 * Parses NDJSON lines from stdout and calls onData with human-readable text snippets.
 * Returns the final result text and stderr.
 */
export function spawnClaudeStreaming(
  task: string,
  cwd: string,
  onData?: (chunk: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let resultText = "";
    let stderr = "";
    let lineBuffer = "";

    // Strip ANTHROPIC_API_KEY so the claude CLI uses subscription auth
    // (from `claude login`) instead of billing against the API key.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ANTHROPIC_API_KEY: _stripKey, CLAUDECODE: _stripClaude2, ...cleanEnv } = process.env;

    const proc = spawn(
      "claude",
      [
        "--dangerously-skip-permissions",
        "--print",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
      ],
      { cwd, env: cleanEnv, shell: false },
    );

    // Write the task as a stream-json user message then close stdin
    const inputMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: task },
      session_id: `talome-${Date.now()}`,
    });
    proc.stdin?.write(inputMsg + "\n");
    proc.stdin?.end();

    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;

          if (msg.type === "result" && typeof msg.result === "string") {
            resultText = msg.result;
          }

          if (msg.type === "assistant") {
            const message = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined;
            const contentBlocks = message?.content ?? [];
            for (const block of contentBlocks) {
              if (block.type === "text" && block.text) {
                onData?.(block.text);
              } else if (block.type === "tool_use" && block.name) {
                const inputStr = block.input ? ` ${JSON.stringify(block.input).slice(0, 120)}` : "";
                onData?.(`\n[${block.name}]${inputStr}\n`);
              }
            }
          }

          // Tool results from user messages (bash output etc.)
          if (msg.type === "user") {
            const toolUseResult = msg.tool_use_result as { stdout?: string; stderr?: string } | undefined;
            if (toolUseResult?.stdout) {
              const out = toolUseResult.stdout.trim();
              if (out) onData?.(out + "\n");
            }
          }
        } catch {
          // Non-JSON line — pass through as-is
          if (trimmed) onData?.(trimmed + "\n");
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
    const p3 = proc as any;
    p3.on("close", (code: number | null) => {
      // Flush any remaining buffer
      if (lineBuffer.trim()) {
        try {
          const msg = JSON.parse(lineBuffer) as Record<string, unknown>;
          if (msg.type === "result" && typeof msg.result === "string") {
            resultText = msg.result;
          }
        } catch {
          // ignore
        }
      }
      resolve({ code: code ?? 1, stdout: resultText, stderr });
    });

    p3.on("error", (err: Error) =>
      resolve({ code: 1, stdout: resultText, stderr: `${stderr}\n${err.message}`.trim() }),
    );
  });
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const diff = await spawnProcess("git", ["diff", "--name-only"], cwd);
  const untracked = await spawnProcess("git", ["ls-files", "--others", "--exclude-standard"], cwd);
  return [
    ...diff.stdout.split("\n"),
    ...untracked.stdout.split("\n"),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runTypecheck(dir: string): Promise<{ ok: boolean; errors: string }> {
  // If the directory has no tsconfig.json (e.g. monorepo root with scope "full"),
  // check both apps/core and apps/dashboard individually.
  if (!existsSync(join(dir, "tsconfig.json"))) {
    const coreDir = join(dir, "apps", "core");
    const dashDir = join(dir, "apps", "dashboard");
    const dirs = [coreDir, dashDir].filter((d) => existsSync(join(d, "tsconfig.json")));
    if (dirs.length === 0) {
      return { ok: true, errors: "" };
    }
    const results = await Promise.all(dirs.map((d) => spawnProcess("pnpm", ["exec", "tsc", "--noEmit"], d)));
    const allOk = results.every((r) => r.code === 0);
    const allErrors = results
      .filter((r) => r.code !== 0)
      .map((r) => `${r.stdout}\n${r.stderr}`.trim())
      .join("\n\n");
    return { ok: allOk, errors: allErrors };
  }

  const result = await spawnProcess("pnpm", ["exec", "tsc", "--noEmit"], dir);
  return {
    ok: result.code === 0,
    errors: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

export async function stashRollback(cwd: string): Promise<string> {
  const stashMsg = `talome-autorollback-${Date.now()}`;
  await spawnProcess("git", ["stash", "push", "-u", "-m", stashMsg], cwd);
  return stashMsg;
}
