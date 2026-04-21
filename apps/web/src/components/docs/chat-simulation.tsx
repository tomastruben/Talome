"use client";

import { type ReactNode } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: ReactNode;
}

/**
 * Simulates Talome's chat UI inside documentation pages.
 *
 * Usage in MDX:
 * ```mdx
 * <ChatSimulation>
 *   <UserMessage>Set up a media stack</UserMessage>
 *   <AssistantMessage>
 *     Installing 5 apps...
 *     <ToolCall tool="search_apps" result="found Jellyfin, Sonarr, Radarr" />
 *     <ToolCall tool="install_app × 5" result="all containers healthy" />
 *     Your media stack is running.
 *   </AssistantMessage>
 * </ChatSimulation>
 * ```
 */

export function ChatSimulation({ children }: { children: ReactNode }) {
  return (
    <div className="my-8 overflow-hidden rounded-2xl border border-border/20 bg-[oklch(0.13_0_0)]">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-border/10 px-4 py-2.5">
        <div className="flex gap-1.5">
          <div className="size-2.5 rounded-full bg-[oklch(0.5_0_0)]" />
          <div className="size-2.5 rounded-full bg-[oklch(0.5_0_0)]" />
          <div className="size-2.5 rounded-full bg-[oklch(0.5_0_0)]" />
        </div>
        <span className="ml-2 text-xs text-[oklch(0.5_0_0)]">Talome Assistant</span>
      </div>
      {/* Messages */}
      <div className="flex flex-col gap-4 p-5">
        {children}
      </div>
    </div>
  );
}

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[oklch(0.25_0_0)] px-4 py-2.5 text-sm text-[oklch(0.92_0_0)]">
        {children}
      </div>
    </div>
  );
}

export function AssistantMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2 text-sm text-[oklch(0.85_0_0)]">
        {children}
      </div>
    </div>
  );
}

export function ToolCall({ tool, result }: { tool: string; result?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/10 bg-[oklch(0.17_0_0)] px-3 py-2 font-mono text-xs">
      <span className="shrink-0 text-[oklch(0.723_0.191_149.58)]">⚙</span>
      <div className="min-w-0">
        <span className="text-[oklch(0.7_0_0)]">{tool}</span>
        {result && (
          <span className="text-[oklch(0.55_0_0)]"> → {result}</span>
        )}
      </div>
    </div>
  );
}
