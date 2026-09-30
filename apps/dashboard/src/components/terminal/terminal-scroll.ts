export interface TerminalScrollBufferState {
  type: "normal" | "alternate";
  baseY: number;
}

/**
 * xterm converts wheel gestures to cursor-key input whenever the active buffer
 * has no scrollback. That is useful for alternate-screen TUIs such as Codex,
 * tmux, and vim, but it is surprising at an ordinary shell prompt where the
 * generated escape sequence can be echoed as visible `^[[A` text.
 */
export function shouldSuppressEmptyNormalBufferWheel(
  buffer: TerminalScrollBufferState,
): boolean {
  return buffer.type === "normal" && buffer.baseY === 0;
}
