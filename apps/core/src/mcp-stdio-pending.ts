/**
 * In-flight work of the MCP stdio process that must not be cut short when its
 * client disconnects (see mcp-stdio-lifecycle.ts): every app operation this
 * process is running — backups, restores, updates, rollbacks, installs — and
 * any backup/restore holding the backup module's per-app lock.
 */

import { listAppOperations } from "./backup/state.js";
import { listActiveOperationsInProcess } from "./ops/operations.js";

export function inFlightAppWork(): string[] {
  const out = listActiveOperationsInProcess().map((op) => `${op.kind} of ${op.appId}`);
  for (const op of listAppOperations()) {
    const label = `${op.kind} of ${op.appId}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
