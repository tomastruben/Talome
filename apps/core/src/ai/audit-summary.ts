/**
 * Human-readable summaries of tool arguments for the audit log.
 * Callers pass arguments through redactSecrets() first; the default branch
 * redacts again so nothing credential-shaped is ever written.
 */

import { summarizeForAudit } from "../utils/redact.js";

/** Produce a concise, human-readable details string for audit log entries. */
export function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "track_issue":
      return `${args.priority} ${args.category}: ${args.title}`;
    case "remember":
      return String(args.content ?? args.text ?? "").slice(0, 200);
    case "forget":
      return `memory: ${args.id ?? args.query ?? ""}`;
    case "apply_change":
      return String(args.description ?? args.task ?? "").slice(0, 200);
    case "set_app_env":
      return `${args.appId}: ${args.key}=${args.value ? "***" : "(empty)"}`;
    case "install_app":
    case "uninstall_app":
    case "start_app":
    case "stop_app":
    case "restart_app":
    case "update_app":
      return String(args.appId ?? args.name ?? "");
    case "create_automation":
    case "update_automation":
    case "delete_automation":
      return String(args.name ?? args.id ?? "");
    default:
      return summarizeForAudit(args);
  }
}
