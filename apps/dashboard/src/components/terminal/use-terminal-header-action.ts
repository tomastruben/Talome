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

export function useTerminalHeaderAction() {
  const launchAgent = useAtomValue(launchTerminalAgentAtom);
  const [agent, setAgent] = useAtom(terminalAgentAtom);

  useEffect(() => {
    const savedAgent = localStorage.getItem(TERMINAL_AGENT_STORAGE_KEY);
    if (savedAgent === "claude-code" || savedAgent === "codex") {
      setAgent(savedAgent);
    }
  }, [setAgent]);

  const selectAgent = useCallback((nextAgent: TerminalAgent) => {
    setAgent(nextAgent);
    localStorage.setItem(TERMINAL_AGENT_STORAGE_KEY, nextAgent);
  }, [setAgent]);

  const agentItems = useMemo<TerminalHeaderActionItem[]>(() => [
    {
      id: "terminal-agent-claude",
      label: "Claude Code",
      active: agent === "claude-code",
      onSelect: () => selectAgent("claude-code"),
    },
    {
      id: "terminal-agent-codex",
      label: "Codex",
      active: agent === "codex",
      onSelect: () => selectAgent("codex"),
    },
  ], [agent, selectAgent]);

  const commandItems = useMemo<TerminalHeaderActionItem[]>(() => [
    {
      id: "terminal-continue-agent",
      label: "Continue session",
      disabled: !launchAgent,
      onSelect: () => launchAgent?.(agent, true),
    },
    {
      id: "terminal-new-agent-session",
      label: "New session",
      disabled: !launchAgent,
      onSelect: () => launchAgent?.(agent, false),
    },
  ], [agent, launchAgent]);

  return {
    agent,
    agentItems,
    commandItems,
    disabled: !launchAgent,
    label: agent === "codex" ? "Codex" : "Claude Code",
  };
}
