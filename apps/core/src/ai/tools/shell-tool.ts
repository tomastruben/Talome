import { tool } from "ai";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeAuditEntry } from "../../db/audit.js";
import { getSecurityMode } from "../tool-gateway.js";

const execAsync = promisify(exec);

// ── Permissive mode: regex blocklist (legacy, easily bypassed but better than nothing)
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r)\s/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9\s+-1\b/,
  /\bchmod\s+777\s+\//,
  /\biptables\s+-F\b/,
];

// ── Cautious mode: command allowlist (safe-by-default).
// Deliberately excludes `docker` — Docker operations must go through
// execContainerTool / the docker-tools API, which enforces its own
// container allowlist and argument checks. A `docker exec` through
// run_shell would bypass all of that.
// Also excludes `curl` and `mv` in cautious mode: curl can be piped into
// a shell, mv can rename across mount points in ways that become
// destructive.
export const SHELL_ALLOWLIST = new Set([
  // Read-only system info
  "ls", "cat", "head", "tail", "df", "du", "free", "uptime", "whoami",
  "date", "uname", "pwd", "wc", "sort", "grep", "awk", "sed", "stat",
  "file", "which", "top", "ps", "env", "echo", "test", "id", "hostname",
  // File operations (additive, non-destructive)
  "mkdir", "touch", "cp", "tar", "gzip", "gunzip", "zip", "unzip",
  // Network diagnostics
  "ping", "dig", "nslookup", "ss", "ifconfig", "ip",
  // Search
  "find", "locate", "rg",
]);

/**
 * Extract the base command from a shell command string.
 * Handles absolute paths (/usr/bin/ls → ls) and env prefixes.
 */
function extractBaseCommand(command: string): string {
  const trimmed = command.trim();

  // Skip env var assignments at the start (FOO=bar cmd)
  const parts = trimmed.split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;
  if (i >= parts.length) return "";

  const cmd = parts[i];
  // Strip path: /usr/bin/ls → ls
  const base = cmd.split("/").pop() ?? cmd;
  return base;
}

export const runShellTool = tool({
  description:
    "Run a shell command on the Talome host. Use ONLY for commands explicitly requested by the user. Every execution is logged to the audit trail.",
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute"),
  }),
  execute: async ({ command }) => {
    const mode = getSecurityMode();

    // Locked mode: shell entirely disabled
    if (mode === "locked") {
      writeAuditEntry(`run_shell BLOCKED (locked): ${command}`, "destructive", command, false);
      return {
        error: 'Shell access is disabled. Security mode is set to "locked". An admin can change this in Settings > Security.',
      };
    }

    // Cautious mode: allowlist-based filtering
    if (mode === "cautious") {
      const baseCmd = extractBaseCommand(command);
      if (!baseCmd || !SHELL_ALLOWLIST.has(baseCmd)) {
        writeAuditEntry(`run_shell BLOCKED (not in allowlist): ${command}`, "destructive", command, false);
        return {
          error: `Command "${baseCmd || command}" is not in the allowed command list for cautious mode. Allowed commands: ${[...SHELL_ALLOWLIST].slice(0, 20).join(", ")}... An admin can switch to permissive mode in Settings > Security.`,
        };
      }
    }

    // Permissive mode: regex blocklist
    if (mode === "permissive") {
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          writeAuditEntry(`run_shell BLOCKED: ${command}`, "destructive", command, false);
          return {
            error: `Command blocked: matches dangerous pattern. This command could cause irreversible damage.`,
          };
        }
      }
    }

    writeAuditEntry(`run_shell: ${command}`, "destructive", command);
    try {
      const { stdout, stderr } = await execAsync(command, { timeout: 30_000 });
      return stdout || stderr || "(no output)";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return e.stdout || e.stderr || e.message || "Command failed";
    }
  },
});
