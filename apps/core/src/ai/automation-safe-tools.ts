/**
 * Single source of truth for automation-safe tools.
 *
 * These tools can be used in automation `tool_action` and `ai_prompt` steps.
 * The list is derived from the tool registry tiers — all "read" tools are safe,
 * plus a curated set of "modify" tools that are safe for automated execution.
 *
 * This module is imported by:
 * - engine.ts (to validate and execute tool_action steps)
 * - automation-tools.ts (for the list_automation_safe_tools tool)
 * - automations route (for the /api/automations/tools endpoint)
 */

import { getAllTiers } from "./tool-registry.js";

/** Modify-tier tools that are explicitly approved for automation use */
const ALLOWED_MODIFY_TOOLS = new Set([
  "restart_container",
  "restart_app",
  "start_container",
  "stop_container",
  "start_app",
  "stop_app",
  "jellyfin_scan_library",
  "send_notification",
  "remember",
  "set_app_env",
  "arr_run_command",
  "arr_set_monitoring",
  "backup_app",
]);

export interface AutomationSafeTool {
  name: string;
  tier: "read" | "modify";
}

/**
 * Returns the list of tools available for automation steps.
 * All read-tier tools + curated modify-tier tools.
 */
export function getAutomationSafeTools(): AutomationSafeTool[] {
  const tiers = getAllTiers();
  const tools: AutomationSafeTool[] = [];

  for (const [name, tier] of Object.entries(tiers)) {
    if (tier === "read") {
      tools.push({ name, tier: "read" });
    } else if (tier === "modify" && ALLOWED_MODIFY_TOOLS.has(name)) {
      tools.push({ name, tier: "modify" });
    }
  }

  return tools.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "read" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Returns just the tool names for fast lookup.
 */
export function getAutomationSafeToolNames(): Set<string> {
  return new Set(getAutomationSafeTools().map((t) => t.name));
}
