/**
 * Which shell commands may run without a server-issued approval in cautious
 * mode.
 *
 * run_shell's own cautious allowlist only inspects the first word and then
 * hands the whole string to a shell, so `ls && rm -rf ~` or `echo $(curl x|sh)`
 * would pass it. The approval gate therefore exempts only commands that are a
 * single, read-only program invocation: no shell metacharacters at all, a
 * program from a small read-only set, and none of the flags that make those
 * programs write or execute (find -delete/-exec, sort -o, ...). Everything
 * else goes through the approval flow like any other destructive tool.
 */

/** Programs that only read state when invoked without the flags below. */
const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "df", "du", "free", "uptime", "whoami",
  "date", "uname", "pwd", "wc", "sort", "grep", "stat", "file", "which",
  "ps", "echo", "id", "hostname", "ping", "dig", "nslookup", "ss", "find",
  "locate", "rg",
]);

/** Per-program arguments that turn a read into a write or an exec. */
const UNSAFE_ARGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-[a-zA-Z]*o.*|--output.*|--compress-program.*)$/,
  file: /^(-[a-zA-Z]*C.*|--compile)$/,
  rg: /^(--pre(=.*)?|--pre-glob(=.*)?)$/,
  date: /^(-s|--set(=.*)?)$/,
  hostname: /^[^-]/, // `hostname <name>` sets the hostname
};

/**
 * Any character that lets a shell chain, substitute, redirect, background,
 * expand or escape: ; & | ` $ ( ) < > { } \ ! newlines, quotes (quoting can
 * hide the above from a naive tokenizer, so it is simply not exempt) and glob
 * characters (a glob can expand to a file named like `-delete`).
 */
const SHELL_META = /[;&|`$()<>{}\\!\n\r'"*?[\]]/;

/** True when `command` may run in cautious mode without an approval. */
export function isApprovalExemptShellCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 500 || SHELL_META.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  const program = words[0];
  // No env-var prefixes (FOO=bar cmd) and no paths (./ls, /tmp/ls).
  if (!program || program.includes("=") || program.includes("/")) return false;
  if (!READ_ONLY_PROGRAMS.has(program)) return false;
  const unsafe = UNSAFE_ARGS[program];
  if (unsafe && words.slice(1).some((w) => unsafe.test(w))) return false;
  return true;
}
