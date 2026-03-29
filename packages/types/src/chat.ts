export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  toolCalls?: ToolCallResult[];
}

export interface ToolCallResult {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  approvalRequired?: boolean;
  approved?: boolean;
}
