/** Old display history belongs to a previous PTY. Its input modes must not
 * carry over into the fresh shell created after a daemon restart. */
const RESTORED_SHELL_MODES = "\x1b[?47;1047;1049l\x1b[?1;1000;1001;1002;1003;1004;1005;1006;1015;1016;2004l\x1b>\x1b[?25h\x1b[0m";

export function restoredTerminalHistory(history: string): string {
  return history + RESTORED_SHELL_MODES + "\r\n\x1b[90m── session restored ──\x1b[0m\r\n\r\n";
}
