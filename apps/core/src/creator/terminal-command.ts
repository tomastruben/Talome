function shellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildCreatorTerminalCommand(workspaceRoot: string, promptFile: string, autoMode: boolean): string {
  return `cd -- ${shellArgument(workspaceRoot)} && env -u ANTHROPIC_API_KEY claude${autoMode ? " --dangerously-skip-permissions" : ""} "$(cat -- ${shellArgument(promptFile)})"`;
}
