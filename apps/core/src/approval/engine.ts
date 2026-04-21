import type { ApprovalTier } from "@talome/types";

const TOOL_TIERS: Record<string, ApprovalTier> = {
  list_containers: "read",
  get_container_logs: "read",
  get_system_stats: "read",
  get_disk_usage: "read",
  list_apps: "read",
  check_service_health: "read",
  start_container: "modify",
  stop_container: "modify",
  restart_container: "modify",
  install_app: "modify",
  uninstall_app: "destructive",
  run_shell: "destructive",
  launch_claude_code: "destructive",
  remember: "modify",
};

export function getToolTier(toolName: string): ApprovalTier {
  return TOOL_TIERS[toolName] ?? "read";
}

export function requiresApproval(toolName: string): boolean {
  const tier = getToolTier(toolName);
  return tier === "modify" || tier === "destructive";
}
