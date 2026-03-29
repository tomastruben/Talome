"use client";

import { useState, useCallback } from "react";
import { ClaudeTerminal, type CompleteResponse } from "@/components/terminal/claude-terminal";
import { CORE_URL } from "@/lib/constants";

interface EvolutionTerminalProps {
  sessionName: string;
  /** Shell command to start Claude Code. Omit for reattach (session already running). */
  command?: string;
  taskPrompt: string;
  runId: string;
  scope: string;
  title?: string;
  completeLabel?: string;
  onComplete: (result: CompleteResult) => void;
  onCancel: () => void;
}

export interface CompleteResult {
  ok: boolean;
  rolledBack: boolean;
  filesChanged: string[];
  typeErrors?: string;
  stashMessage?: string;
  duration: number;
}

export function EvolutionTerminal({
  sessionName,
  command,
  taskPrompt,
  runId,
  scope,
  title,
  completeLabel,
  onComplete,
  onCancel,
}: EvolutionTerminalProps) {
  const [completing, setCompleting] = useState(false);

  const handleComplete = useCallback(async (): Promise<CompleteResponse> => {
    setCompleting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/evolution/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, scope, autoRollback: false }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        return { ok: false, typeErrors: errBody?.error ?? `Server error: ${res.status}` };
      }
      const result = (await res.json()) as CompleteResult;

      if (result.ok) {
        // Success — propagate to parent (dismisses terminal, shows result)
        onComplete(result);
        return { ok: true };
      }

      // Type errors — return to ClaudeTerminal so it can send them
      // to Claude Code for fixing. Terminal stays open for retry.
      return { ok: false, typeErrors: result.typeErrors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to complete";
      return { ok: false, typeErrors: msg };
    } finally {
      setCompleting(false);
    }
  }, [runId, scope, onComplete]);

  return (
    <ClaudeTerminal
      sessionName={sessionName}
      command={command}
      taskPrompt={taskPrompt}
      title={title}
      completeLabel={completeLabel}
      onComplete={handleComplete}
      onCancel={onCancel}
      completing={completing}
    />
  );
}
