/**
 * Child process for trust-stdio.test.ts: installs the real stdio shutdown hook
 * on the real process streams, plus a timer that would otherwise keep the
 * process alive forever (the orphaned-mcp-stdio failure mode).
 */
import { installStdioShutdown } from "../../mcp-stdio-lifecycle.js";

setInterval(() => {}, 1_000);
installStdioShutdown({
  stdin: process.stdin,
  stdout: process.stdout,
  signals: process,
  getPpid: () => process.ppid,
  exit: (code) => process.exit(code),
  log: () => {},
});
process.stdin.resume();
process.stdout.write("ready\n");
