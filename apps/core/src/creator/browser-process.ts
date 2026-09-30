import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";

/** Execute the trusted browser runner with parent-owned input and a bounded lifetime. */
export function runNativeBrowserHarness(
  harnessPath: string,
  input: unknown,
  cwd: string,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  const serialized = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LOCALAPPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, [harnessPath], {
      cwd, env, shell: false, detached: grouped, stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    let stderr = "";
    const cleanup = () => {
      // Killing the group also bounds orphaned renderer/browser descendants.
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const timer = setTimeout(() => finish(new Error("Native browser validation timed out; the runner process group was stopped.")), limits.timeoutMs ?? 120_000);
    const record = (chunk: Buffer, errorOutput: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > (limits.maxOutputBytes ?? 4 * 1024 * 1024)) {
        finish(new Error("Native browser validation exceeded its output limit; the runner was stopped."));
        return;
      }
      if (errorOutput) stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      else stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => record(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => record(chunk, true));
    // The installed Node declarations omit ChildProcess event methods.
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) => finish(new Error(`Native browser runner could not start: ${error.message}`)));
    // exit fires even if an orphan retains inherited stdout/stderr descriptors.
    // Stop descendants then wait for close so buffered report bytes are drained.
    events.on("exit", () => cleanup());
    events.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish(code === 0 ? undefined : new Error(
      `Native browser runner failed (${signal ?? code ?? "unknown"}): ${stderr || "No diagnostic output"}`,
    )));
    child.stdin.on("error", (error) => finish(new Error(`Native browser input failed: ${error.message}`)));
    child.stdin.end(serialized);
  });
}
