/**
 * Actor context — who is acting right now, for the whole async call tree.
 *
 * One AsyncLocalStorage shared by the tool execution service (ai/execution.ts)
 * and the app-operations journal (ops/operations.ts). executeTool() runs every
 * tool inside the calling actor's context, so a lifecycle operation started by
 * a tool — however deep — is journaled under the real actor: the session user
 * of a chat turn, the MCP token, the automation, or the agent loop.
 *
 * Kept free of runtime imports (types only) so both the execution service and
 * the journal can depend on it without an import cycle.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TokenScopes } from "../approval/grants.js";

export type ActorKind = "user" | "mcp_token" | "mcp_stdio" | "automation" | "agent_loop";

export type ExecutionSource = "chat" | "mcp" | "automation" | "agent_loop";

export interface Actor {
  kind: ActorKind;
  /** Stable id: user id, token id, automation id, "local" for stdio. */
  id: string;
  /** Human label for audit and approval UI. */
  label: string;
  role?: string;
  /**
   * Per-actor grants. Undefined = owner-level (dashboard user, local stdio).
   * MCP tokens always carry scopes.
   */
  scopes?: TokenScopes;
}

/** How audit rows name each execution source (`MCP: delete_file`, ...). */
export const EXECUTION_SOURCE_LABELS: Record<ExecutionSource, string> = {
  chat: "AI",
  mcp: "MCP",
  automation: "Automation",
  agent_loop: "Agent loop",
};

export interface ExecutionContext {
  actor: Actor;
  source: ExecutionSource;
}

interface ActorContextStore {
  actor?: Actor;
  source?: ExecutionSource;
  /**
   * Explicit app-operation actor string set by the legacy
   * `runWithActor(actor, fn)` API. Wins over `actor` for the journal.
   */
  operationActor?: string;
}

const storage = new AsyncLocalStorage<ActorContextStore>();

/** Run `fn` (and everything it awaits or spawns) as `actor` from `source`. The innermost context wins. */
export function runInActorContext<T>(actor: Actor, source: ExecutionSource, fn: () => T): T {
  return storage.run({ actor, source }, fn);
}

/**
 * Run `fn` with an explicit app-operation actor string, keeping the current
 * execution actor (if any) for everything else.
 */
export function runWithOperationActor<T>(operationActor: string, fn: () => T): T {
  return storage.run({ ...(storage.getStore() ?? {}), operationActor }, fn);
}

/** The execution context in effect, or undefined outside of any. */
export function getExecutionContext(): ExecutionContext | undefined {
  const store = storage.getStore();
  if (!store?.actor || !store.source) return undefined;
  return { actor: store.actor, source: store.source };
}

function cleanPart(value: string, max: number): string {
  // Journal strings end up in UI and conflict messages: one line, bounded.
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

/**
 * The app_operations.actor string for an execution actor:
 * `<kind>:<id> (<label>)` — e.g. `user:u1 (alice (chat))`,
 * `mcp_token:tok-1 (MCP token "Cursor")`, `automation:a1 (Automation: Nightly)`,
 * `agent_loop:remediation (Agent loop remediation)`.
 */
export function formatOperationActor(actor: Actor): string {
  const id = cleanPart(actor.id, 80) || "unknown";
  const base = `${actor.kind}:${id}`;
  const label = cleanPart(actor.label, 120);
  return label && label !== id ? `${base} (${label})` : base;
}

/** The actor to journal an app operation under, or `fallback` outside any context. */
export function currentOperationActor(fallback: string): string {
  const store = storage.getStore();
  if (store?.operationActor) return store.operationActor;
  if (store?.actor) return formatOperationActor(store.actor);
  return fallback;
}
