import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { listContainers } from "../docker/client.js";
import type { AppHook, AppHooks } from "@talome/types";

const exec = promisify(execCb);

export function parseHooks(hooksJson: string | null | undefined): AppHooks | null {
  if (!hooksJson) return null;
  try {
    return JSON.parse(hooksJson) as AppHooks;
  } catch {
    return null;
  }
}

async function discoverContainersForHook(appId: string): Promise<string[]> {
  try {
    const containers = await listContainers();
    return containers
      .filter((c) => {
        const name = c.name.toLowerCase();
        const id = appId.toLowerCase();
        return name === id || name.startsWith(`${id}-`) || name.startsWith(`${id}_`);
      })
      .map((c) => c.id);
  } catch {
    return [];
  }
}

async function runHook(
  hook: AppHook,
  appId: string,
  context: { composePath: string; env: Record<string, string> },
): Promise<{ success: boolean; output?: string; error?: string }> {
  const timeout = hook.timeout ?? 30_000;

  try {
    switch (hook.type) {
      case "shell": {
        const containers = await discoverContainersForHook(appId);
        if (containers.length === 0) {
          return { success: false, error: "No containers found for shell hook" };
        }
        const containerId = containers[0];
        const { stdout, stderr } = await exec(
          `docker exec ${containerId} sh -c ${JSON.stringify(hook.value)}`,
          { cwd: dirname(context.composePath), timeout, maxBuffer: 10 * 1024 * 1024 },
        );
        return { success: true, output: stdout || stderr };
      }
      case "http": {
        const res = await fetch(hook.value, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId, event: "hook" }),
          signal: AbortSignal.timeout(timeout),
        });
        return { success: res.ok, output: `HTTP ${res.status}` };
      }
      case "ai_prompt": {
        console.log(`[lifecycle] AI hook for ${appId}: ${hook.value}`);
        return { success: true, output: `AI prompt queued: ${hook.value}` };
      }
      default:
        return { success: false, error: `Unknown hook type: ${(hook as AppHook).type}` };
    }
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    console.error(`[lifecycle] Hook failed for ${appId}:`, msg);
    return { success: false, error: msg };
  }
}

export async function executeHook(
  hookName: keyof AppHooks,
  appId: string,
  hooksJson: string | null | undefined,
  context: { composePath: string; env: Record<string, string> },
): Promise<void> {
  const hooks = parseHooks(hooksJson);
  if (!hooks) return;
  const hook = hooks[hookName];
  if (!hook) return;

  console.log(`[lifecycle] Running ${hookName} hook for ${appId} (type: ${hook.type})`);
  const result = await runHook(hook, appId, context);
  if (!result.success) {
    console.warn(`[lifecycle] ${hookName} hook failed for ${appId}: ${result.error}`);
  }
}
