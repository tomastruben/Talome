/**
 * Who is asking Talome to run a tool.
 *
 * Every execution path (dashboard chat, messaging, MCP, automations, background
 * loops) identifies itself with an actor so policy, approvals and the audit log
 * can tell them apart.
 */

import type { McpTokenScope } from "./token-scope.js";

export type ExecutionActor =
  /** Dashboard chat — a signed-in person approves destructive calls in the chat UI */
  | { kind: "dashboard"; username?: string }
  /** External MCP client authenticated with a bearer token */
  | { kind: "token"; tokenId: string; tokenName: string; scope: McpTokenScope }
  /** Local Claude Code over the stdio MCP server */
  | { kind: "stdio" }
  /** Telegram / Discord conversation */
  | { kind: "messaging"; platform: "telegram" | "discord"; externalId: string }
  /** Automation step or AI prompt inside an automation */
  | { kind: "automation"; name: string; id?: string }
  /** Autonomous background loops (remediation, setup, digest) */
  | { kind: "background"; loop: string };

/** Stable identity used to bind approvals to the actor that requested them. */
export function actorKey(actor: ExecutionActor): string {
  switch (actor.kind) {
    case "dashboard":
      return "dashboard";
    case "token":
      return `token:${actor.tokenId}`;
    case "stdio":
      return "stdio";
    case "messaging":
      return `messaging:${actor.platform}:${actor.externalId}`;
    case "automation":
      return `automation:${actor.id ?? actor.name}`;
    case "background":
      return `background:${actor.loop}`;
  }
}

/** Human-readable description for audit entries and approval prompts. */
export function describeActor(actor: ExecutionActor): string {
  switch (actor.kind) {
    case "dashboard":
      return actor.username ? `dashboard chat (${actor.username})` : "dashboard chat";
    case "token":
      return `MCP token "${actor.tokenName}" (${actor.tokenId})`;
    case "stdio":
      return "local Claude Code (stdio MCP)";
    case "messaging":
      return `${actor.platform === "telegram" ? "Telegram" : "Discord"} chat ${actor.externalId}`;
    case "automation":
      return `automation "${actor.name}"`;
    case "background":
      return `background ${actor.loop}`;
  }
}
