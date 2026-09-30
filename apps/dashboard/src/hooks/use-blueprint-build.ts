"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { BlueprintState } from "@/components/creator/blueprint-draft-bar";
import { CORE_URL } from "@/lib/constants";

export interface BlueprintBuildSession {
  sessionName: string;
  command: string;
  taskPrompt: string;
  appId: string;
  workspaceRoot: string;
}
interface PreparedBuild {
  blueprint: BlueprintState;
  appId: string;
  workspaceRoot: string;
  taskPrompt: string;
}

async function responseBody(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `${fallback} (${response.status})`);
  return body;
}

/** Preparing is private; a refused execution can retry the same workspace without generating again. */
/**
 * Whether Claude Code skips its permission prompts is the owner's server
 * setting ("Build apps without permission prompts"), not a flag sent from here.
 */
export function useBlueprintBuild(blueprint: BlueprintState, onSession: (session: BlueprintBuildSession) => void, conversationId: string | null = null) {
  const [buildingFor, setBuildingFor] = useState<{ blueprint: BlueprintState; conversationId: string | null } | null>(null);
  const [error, setError] = useState<{ blueprint: BlueprintState; conversationId: string | null; message: string } | null>(null);
  const prepared = useRef<PreparedBuild | null>(null);
  const running = useRef(false);
  const lifecycle = useRef(0);
  const request = useRef<AbortController | null>(null);

  // Invalidate before asynchronous responses can commit into another conversation.
  useLayoutEffect(() => () => {
    lifecycle.current += 1;
    request.current?.abort();
    request.current = null;
    prepared.current = null;
    running.current = false;
    setBuildingFor(null);
    setError(null);
  }, [blueprint, conversationId]);

  const build = useCallback(async () => {
    if (running.current || !blueprint.identity?.name) return;
    running.current = true;
    const currentLifecycle = lifecycle.current;
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () => lifecycle.current === currentLifecycle && !controller.signal.aborted;
    setBuildingFor({ blueprint, conversationId });
    setError(null);
    try {
      let draft = prepared.current?.blueprint === blueprint ? prepared.current : null;
      if (!draft) {
        const response = await fetch(`${CORE_URL}/api/apps/create`, {
          signal: controller.signal, method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: blueprint.identity.description || blueprint.identity.name,
            mode: "both", saveImmediately: false, source: { kind: "auto" }, preBuiltBlueprint: blueprint }),
        });
        const data = await responseBody(response, "Unable to prepare app");
        if (!isCurrent()) return;
        if (!data.draft?.workspace?.rootPath || !data.draft?.app?.id) throw new Error("The app draft did not include a build workspace. Please try again.");
        draft = { blueprint, appId: data.draft.app.id, workspaceRoot: data.draft.workspace.rootPath,
          taskPrompt: data.draft.taskPrompt ?? `You are helping the user create "${blueprint.identity.name}". Read the blueprint and instructions in .talome-creator/ first.` };
        prepared.current = draft;
      }
      if (!isCurrent()) return;
      const response = await fetch(`${CORE_URL}/api/apps/create/execute`, {
        signal: controller.signal, method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceRoot: draft.workspaceRoot, taskPrompt: draft.taskPrompt, appId: draft.appId }),
      });
      const execution = await responseBody(response, "Unable to start build");
      if (!isCurrent()) return;
      if (!execution.sessionName || !execution.command) throw new Error("The build did not return a terminal session. Please try again.");
      onSession({ sessionName: execution.sessionName, command: execution.command,
        taskPrompt: execution.taskPrompt ?? draft.taskPrompt, workspaceRoot: execution.workspaceRoot ?? draft.workspaceRoot, appId: draft.appId });
    } catch (failure) {
      if (isCurrent()) setError({ blueprint, conversationId, message: failure instanceof Error ? failure.message : "Unable to start build" });
    } finally {
      if (isCurrent()) {
        running.current = false;
        request.current = null;
        setBuildingFor(null);
      }
    }
  }, [blueprint, conversationId, onSession]);
  return {
    build,
    building: buildingFor?.blueprint === blueprint && buildingFor.conversationId === conversationId,
    error: error?.blueprint === blueprint && error.conversationId === conversationId ? error.message : null,
  };
}
