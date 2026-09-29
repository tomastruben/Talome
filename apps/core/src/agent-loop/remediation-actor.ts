/**
 * Who remediation acts as — shared by the agent loop (remediation.ts) and the
 * MCP stdio server that Claude Code launches for the Claude Code remediation
 * path (mcp-stdio.ts). Kept free of tool imports so the stdio server stays light.
 *
 * The Claude Code path spawns `claude` with TALOME_MCP_ACTOR set; the stdio
 * server it launches then runs every call as agent_loop:remediation (not the
 * interactive mcp_stdio owner), limited to the remediation tool set — so the
 * security mode, approvals, audit and the app-operations journal see the agent
 * loop, exactly as on the API path.
 */

import { agentLoopActor, type Actor } from "../ai/execution.js";

/** Environment variable carrying the actor hint for the MCP stdio server. */
export const MCP_ACTOR_ENV = "TALOME_MCP_ACTOR";

/** Hint: remediation that may act (autoRemediate on). */
export const REMEDIATION_ACTOR_HINT = "agent_loop:remediation";
/** Hint: remediation limited to diagnosis (read tier only). */
export const REMEDIATION_DIAGNOSE_ACTOR_HINT = "agent_loop:remediation:diagnose";

export const REMEDIATION_ACTOR: Actor = agentLoopActor("remediation", "Agent loop remediation");

/** Write tools remediation may use; a call to one of them that ran is an attempted fix. */
export const REMEDIATION_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "restart_container",
  "cleanup_docker",
  "jellyfin_scan_library",
  "rollback_update",
]);

/** Every tool the remediation agent may call (read-heavy, limited writes). */
export const REMEDIATION_TOOL_NAMES: readonly string[] = [
  "list_containers",
  "get_container_logs",
  "search_container_logs",
  "check_service_health",
  "get_system_stats",
  "get_disk_usage",
  "get_system_health",
  "diagnose_app",
  "arr_get_status",
  "arr_get_queue_details",
  "arr_list_download_clients",
  "qbt_list_torrents",
  "jellyfin_get_status",
  "check_dependencies",
  ...REMEDIATION_WRITE_TOOLS,
];

/**
 * The actor the MCP stdio server runs as. Only the exact remediation hints are
 * honored; anything else keeps the local owner actor. (The hint cannot widen
 * access: the stdio process already runs as the owner.)
 */
export function stdioActorFromEnv(env: NodeJS.ProcessEnv, fallback: Actor): Actor {
  const hint = env[MCP_ACTOR_ENV];
  if (hint !== REMEDIATION_ACTOR_HINT && hint !== REMEDIATION_DIAGNOSE_ACTOR_HINT) return fallback;
  return {
    ...REMEDIATION_ACTOR,
    scopes: {
      maxTier: hint === REMEDIATION_DIAGNOSE_ACTOR_HINT ? "read" : "destructive",
      domains: "all",
      apps: "all",
      tools: [...REMEDIATION_TOOL_NAMES],
    },
  };
}
