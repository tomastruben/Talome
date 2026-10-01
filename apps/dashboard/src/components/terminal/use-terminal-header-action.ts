"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  launchTerminalAgentAtom,
  terminalAgentAtom,
  type TerminalAgent,
} from "@/atoms/terminal";

const TERMINAL_AGENT_STORAGE_KEY = "talome-terminal-agent";

export interface TerminalHeaderActionItem {
  id: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** The coding agents the Terminal can launch, in menu order. */
export const TERMINAL_AGENTS: ReadonlyArray<{ id: TerminalAgent; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "kimi", label: "Kimi Code" },
];

export function terminalAgentLabel(agent: TerminalAgent): string {
  return TERMINAL_AGENTS.find((entry) => entry.id === agent)?.label ?? "Claude Code";
}

/**
 * What each agent's launch command honours (terminal-page.tsx builds them):
 * Auto adds --dangerously-skip-permissions (Claude Code) or --auto (Kimi
 * Code), and remote control adds --remote-control (Claude Code only). Codex
 * keeps its own permission settings.
 */
export function terminalAgentSupports(agent: TerminalAgent): { auto: boolean; remote: boolean } {
  return { auto: agent !== "codex", remote: agent === "claude-code" };
}

function isTerminalAgent(value: string | null): value is TerminalAgent {
  return TERMINAL_AGENTS.some((entry) => entry.id === value);
}

/**
 * The agent the Terminal launches and the two ways to launch it (continue the
 * last conversation, or start a new one). Both are agent launches, named for
 * the agent so they read apart from the shell's own sessions.
 */
export function useTerminalHeaderAction() {
  const launchAgent = useAtomValue(launchTerminalAgentAtom);
  const [agent, setAgent] = useAtom(terminalAgentAtom);

  useEffect(() => {
    const savedAgent = localStorage.getItem(TERMINAL_AGENT_STORAGE_KEY);
    if (isTerminalAgent(savedAgent)) setAgent(savedAgent);
  }, [setAgent]);

  const selectAgent = useCallback((nextAgent: TerminalAgent) => {
    setAgent(nextAgent);
    localStorage.setItem(TERMINAL_AGENT_STORAGE_KEY, nextAgent);
  }, [setAgent]);

  /** Launch the selected agent: `resume` continues its last conversation. */
  const launch = useCallback((resume: boolean) => {
    launchAgent?.(agent, resume);
  }, [agent, launchAgent]);

  const agentItems = useMemo<TerminalHeaderActionItem[]>(() => TERMINAL_AGENTS.map((entry) => ({
    id: `terminal-agent-${entry.id === "claude-code" ? "claude" : entry.id}`,
    label: entry.label,
    active: agent === entry.id,
    onSelect: () => selectAgent(entry.id),
  })), [agent, selectAgent]);

  const label = terminalAgentLabel(agent);

  const commandItems = useMemo<TerminalHeaderActionItem[]>(() => [
    {
      id: "terminal-continue-agent",
      label: `Continue ${label}`,
      disabled: !launchAgent,
      onSelect: () => launch(true),
    },
    {
      id: "terminal-new-agent-session",
      label: `New ${label} session`,
      disabled: !launchAgent,
      onSelect: () => launch(false),
    },
  ], [label, launch, launchAgent]);

  return {
    agent,
    agentItems,
    commandItems,
    /** True until the terminal is connected and can take a launch command. */
    disabled: !launchAgent,
    label,
    launch,
    selectAgent,
    supports: terminalAgentSupports(agent),
  };
}
