import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCodexCommand, buildKimiCommand } from "@/components/terminal/terminal-page";

describe("buildCodexCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the resolved Codex executable into a new tmux session", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);

    const command = buildCodexCommand("/Users/tomas/.talome/server", false);

    expect(command).toContain('codex_bin="$(command -v codex 2>/dev/null)"');
    expect(command).toContain(
      'tmux new-session -s talome-codex-1234 "\\"$codex_bin\\""',
    );
    expect(command).toContain('else cd /Users/tomas/.talome/server && "$codex_bin"; fi');
  });

  it("uses the same resolved executable when continuing the last session", () => {
    const command = buildCodexCommand("/Volumes/Media Hub/dev/Talome", true);

    expect(command).toContain(
      'cd "/Volumes/Media Hub/dev/Talome" && tmux new-session -A -s talome-codex "\\"$codex_bin\\" resume --last"',
    );
    expect(command).toContain(
      'else cd "/Volumes/Media Hub/dev/Talome" && "$codex_bin" resume --last; fi',
    );
  });
});

describe("buildKimiCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the native Kimi Code CLI for a new tmux session", () => {
    vi.spyOn(Date, "now").mockReturnValue(5678);

    const command = buildKimiCommand("/Users/tomas/.talome/server", false);

    expect(command).toContain('kimi_bin="$(command -v kimi 2>/dev/null)"');
    expect(command).toContain('[ -x "$HOME/.kimi-code/bin/kimi" ]');
    expect(command).toContain(
      'tmux new-session -s talome-kimi-5678 "\\"$kimi_bin\\""',
    );
    expect(command).toContain('else cd /Users/tomas/.talome/server && "$kimi_bin"; fi');
  });

  it("continues the native Kimi session and enables auto mode", () => {
    const command = buildKimiCommand("/Volumes/Media Hub/dev/Talome", true, true);

    expect(command).toContain(
      'cd "/Volumes/Media Hub/dev/Talome" && tmux new-session -A -s talome-kimi "\\"$kimi_bin\\" --continue --auto"',
    );
    expect(command).toContain(
      'else cd "/Volumes/Media Hub/dev/Talome" && "$kimi_bin" --continue --auto; fi',
    );
  });
});
