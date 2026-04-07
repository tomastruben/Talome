import { atom } from "jotai";

export const terminalCommandAtom = atom<string | null>(null);
export const terminalOpenAtom = atom(false);
export const launchClaudeCodeAtom = atom<((resume?: boolean) => void) | null>(null);
/** When set, the Terminal page will switch to this session on mount */
export const terminalSessionAtom = atom<string | null>(null);
/** Sent as terminal input after a delay once the initial command has been dispatched */
export const terminalFollowUpAtom = atom<string | null>(null);
/** Auto mode — launch Claude Code with --dangerously-skip-permissions */
export const terminalAutoAtom = atom(false);
/** Remote Control — launch Claude Code with --remote-control for mobile/browser access */
export const terminalRemoteAtom = atom(false);
/** True when Claude Code is actively running with --remote-control (not just the toggle preference) */
export const terminalRemoteActiveAtom = atom(false);
