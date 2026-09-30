/**
 * Child process for trust-stdio.test.ts: installs the real stdio shutdown hook
 * on the real process streams, plus a timer that would otherwise keep the
 * process alive forever (the orphaned-mcp-stdio failure mode).
 */
import { installStdioShutdown } from "../../mcp-stdio-lifecycle.js";

setInterval(() => {}, 1_000);
// STDIO_CHILD_BUSY_MS: pretend a restore is running for that long after startup
const busyUntil = Date.now() + (Number(process.env.STDIO_CHILD_BUSY_MS) || 0);
installStdioShutdown({
  pendingWork: () => (Date.now() < busyUntil ? ["restore of testapp"] : []),
  drainPollMs: 50,
  stdin: process.stdin,
  stdout: process.stdout,
  signals: process,
  getPpid: () => process.ppid,
  exit: (code) => process.exit(code),
  log: () => {},
});
process.stdin.resume();
process.stdout.write("ready\n");
