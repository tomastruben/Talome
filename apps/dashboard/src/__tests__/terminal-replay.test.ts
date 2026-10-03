import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { restoredTerminalHistory } from "../../../core/src/terminal-replay";

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

describe("terminal history recovered into a fresh shell", () => {
  it("preserves history while turning off stale mouse, focus and application input modes", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    try {
      await write(terminal, restoredTerminalHistory("Saved output\r\n\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?1h\x1b[?2004h"));
      expect(terminal.modes.mouseTrackingMode).toBe("none");
      expect(terminal.modes.sendFocusMode).toBe(false);
      expect(terminal.modes.applicationCursorKeysMode).toBe(false);
      expect(terminal.modes.bracketedPasteMode).toBe(false);
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe("Saved output");
      await write(terminal, "\x1b[?1003h\x1b[?1006h");
      expect(terminal.modes.mouseTrackingMode).toBe("any");
    } finally { terminal.dispose(); }
  });

  it("leaves the alternate screen before showing the restored-shell marker", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    try {
      await write(terminal, restoredTerminalHistory("Saved output\r\n\x1b[?1049hOld app"));
      expect(terminal.buffer.active.type).toBe("normal");
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe("Saved output");
      expect(terminal.buffer.normal.getLine(2)?.translateToString(true)).toContain("session restored");
    } finally { terminal.dispose(); }
  });
});
