/**
 * Named, server-side choices about when Claude Code may run without its
 * permission prompts. They replace the one browser-local "Auto" switch that
 * used to control chat auto-approve, confirmations, app builds, evolution
 * runs and the terminal all at once.
 *
 * - `creator_skip_permission_prompts`: app builds launched from the
 *   Assistant's creator open Claude Code with --dangerously-skip-permissions.
 * - `evolution_skip_permission_prompts`: evolution runs (suggestions, bug
 *   hunt, reinject) open Claude Code with --dangerously-skip-permissions.
 *
 * Both are off unless an admin turns them on in Settings (the settings route
 * is admin-only, and the agent's own settings tool treats these keys as
 * protected, so a model can't switch its own prompts off). Headless runs
 * never use the flag either way (ai/claude-process.ts). The Assistant has no
 * auto-approve: its calls go through the security mode and server-issued
 * approvals (ai/execution.ts) like every other caller.
 */
import { getSetting } from "../utils/settings.js";

export const CREATOR_SKIP_PROMPTS_KEY = "creator_skip_permission_prompts";
export const EVOLUTION_SKIP_PROMPTS_KEY = "evolution_skip_permission_prompts";

export const AUTONOMY_SETTING_KEYS = [CREATOR_SKIP_PROMPTS_KEY, EVOLUTION_SKIP_PROMPTS_KEY] as const;

function enabled(key: string): boolean {
  return getSetting(key) === "true";
}

/**
 * Whether a terminal launch may add --dangerously-skip-permissions. The
 * server setting is the owner's explicit choice; a request can only narrow
 * it (`requested === false` keeps the prompts), never widen it.
 */
export function creatorSkipsPermissionPrompts(requested?: boolean): boolean {
  return requested !== false && enabled(CREATOR_SKIP_PROMPTS_KEY);
}

export function evolutionSkipsPermissionPrompts(requested?: boolean): boolean {
  return requested !== false && enabled(EVOLUTION_SKIP_PROMPTS_KEY);
}
