"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage, DynamicToolUIPart, FileUIPart } from "ai";
import { isToolUIPart, getToolName } from "ai";
import Image from "next/image";
import {
  HugeiconsIcon,
  Copy01Icon,
  CheckmarkCircle01Icon,
  FileAttachmentIcon,
  Refresh04Icon,
  PackageOpenIcon,
} from "@/components/icons";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
  MessageSources,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  LaunchTerminalCard,
} from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from "@/components/ai-elements/confirmation";

interface ChatMessageProps {
  message: UIMessage;
  addToolApprovalResponse?: (response: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
  onRegenerate?: () => void;
  onBlueprintUpdate?: (input: Record<string, unknown>) => void;
  isLast?: boolean;
  isStreaming?: boolean;
}

function MessageAttachment({ part }: { part: FileUIPart }) {
  const isImage = part.mediaType?.startsWith("image/");

  if (isImage && part.url) {
    return (
      <a
        href={part.url}
        rel="noreferrer"
        target="_blank"
        className="block overflow-hidden rounded-xl border border-border/60 bg-background/70"
      >
        <Image
          alt={part.filename || "Attached image"}
          className="max-h-80 w-full object-cover"
          src={part.url}
          unoptimized
          width={960}
          height={960}
        />
        <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {part.filename || "Image"}
        </div>
      </a>
    );
  }

  const content = (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <HugeiconsIcon icon={FileAttachmentIcon} size={16} />
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{part.filename || "Attachment"}</div>
        <div className="truncate text-xs text-muted-foreground">
          {part.mediaType || "File"}
        </div>
      </div>
    </div>
  );

  if (!part.url) {
    return content;
  }

  return (
    <a href={part.url} rel="noreferrer" target="_blank">
      {content}
    </a>
  );
}

function formatToolName(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const STREAMING_TOOLS = new Set(["plan_change", "apply_change"]);

function LiveToolOutput({ isRunning }: { isRunning: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRunning) {
      setConnected(false);
      return;
    }

    setLines([]);
    const es = new EventSource("/api/evolution/stream");

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as { type: string; chunk?: string };
        if (event.type === "connected") {
          setConnected(true);
        } else if (event.type === "output" && event.chunk) {
          setLines((prev) => {
            const incoming = event.chunk!.split("\n");
            const next = [...prev];
            if (next.length === 0) return incoming;
            next[next.length - 1] += incoming[0];
            for (let i = 1; i < incoming.length; i++) next.push(incoming[i]);
            return next.length > 300 ? next.slice(-300) : next;
          });
        } else if (event.type === "started") {
          setLines([]);
        }
      } catch {
        // ignore
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [isRunning]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  if (!isRunning) return null;

  return (
    <div className="relative border-t border-border/30 rounded-b-xl overflow-hidden">
      <div
        ref={outputRef}
        className="max-h-64 overflow-y-auto bg-[#0d0d0d] px-4 py-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <span className="text-white/30 animate-pulse">
            {connected ? "Waiting for output…" : "Connecting…"}
          </span>
        ) : (
          lines.map((line, i) => {
            const isToolCall = line.startsWith("[") && line.includes("]");
            return (
              <div
                key={i}
                className={isToolCall ? "text-status-info/60" : "text-white/50"}
              >
                {line || "\u00a0"}
              </div>
            );
          })
        )}
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 rounded-b-xl bg-gradient-to-t from-black to-transparent" />
    </div>
  );
}

/** Compact inline marker for blueprint tool calls */
function BlueprintMarker({ input }: { input: Record<string, unknown> }) {
  const section = input.section as string;
  let label = "";

  switch (section) {
    case "identity": {
      const name = input.name as string | undefined;
      label = name ? `Set identity → ${name}` : "Updated identity";
      break;
    }
    case "services": {
      const services = input.services as Array<{ name: string; image: string }> | undefined;
      if (services?.length) {
        const names = services.map((s) => s.image.split(":")[0].split("/").pop()).join(", ");
        label = `Added ${services.length} service${services.length !== 1 ? "s" : ""}: ${names}`;
      } else {
        label = "Updated services";
      }
      break;
    }
    case "env": {
      const env = input.env as Array<unknown> | undefined;
      label = `Set ${env?.length ?? 0} environment variable${(env?.length ?? 0) !== 1 ? "s" : ""}`;
      break;
    }
    case "scaffold":
      label = `Scaffold: ${input.kind ?? "none"}`;
      break;
    case "criteria": {
      const criteria = input.criteria as string[] | undefined;
      label = `Added ${criteria?.length ?? 0} success criteria`;
      break;
    }
    default:
      label = `Updated ${section}`;
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-card/20 px-3 py-2 my-1">
      <HugeiconsIcon icon={PackageOpenIcon} size={12} className="text-status-warning/60 shrink-0" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function ChatMessage({
  message,
  addToolApprovalResponse,
  onRegenerate,
  onBlueprintUpdate,
  isLast,
  isStreaming = false,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const emittedBlueprints = useRef(new Set<string>());

  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  const sources = message.parts
    .filter((p): p is { type: "source-url"; sourceId: string; url: string; title?: string } => p.type === "source-url")
    .filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i);

  const handleCopy = useCallback(async () => {
    if (!textContent) return;
    await navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [textContent]);

  // Group consecutive text parts
  type RenderBlock =
    | { kind: "text"; key: string; text: string; toolContextNames: string[] }
    | { kind: "file"; key: string; part: FileUIPart }
    | { kind: "tool"; key: string; part: DynamicToolUIPart };

  const blocks: RenderBlock[] = [];
  let lastToolName: string | null = null;
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.length === 0) continue;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text") {
        last.text += part.text;
      } else {
        blocks.push({
          kind: "text",
          key: `text-${blocks.length}`,
          text: part.text,
          toolContextNames: lastToolName ? [lastToolName] : [],
        });
      }
    } else if (part.type === "file") {
      blocks.push({
        kind: "file",
        key: `${part.filename || "file"}-${blocks.length}`,
        part,
      });
    } else if (isToolUIPart(part)) {
      const toolPart = part as DynamicToolUIPart;
      const toolName = getToolName(toolPart);
      if (toolName) {
        lastToolName = toolName;
      }
      blocks.push({ kind: "tool", key: toolPart.toolCallId, part: toolPart });
    }
  }

  // Emit blueprint updates to the draft bar
  useEffect(() => {
    if (!onBlueprintUpdate) return;
    for (const block of blocks) {
      if (block.kind !== "tool") continue;
      const p = block.part;
      const name = getToolName(p);
      if (name !== "design_app_blueprint") continue;
      if (p.state !== "output-available") continue;
      if (emittedBlueprints.current.has(p.toolCallId)) continue;
      emittedBlueprints.current.add(p.toolCallId);
      const input = p.input as Record<string, unknown> | undefined;
      if (input?.section) {
        onBlueprintUpdate(input);
      }
    }
  });

  return (
    <Message from={message.role}>
      <MessageContent>
        {blocks.map((block) => {
          if (block.kind === "text") {
            return (
              <MessageResponse key={block.key} toolContextNames={block.toolContextNames}>
                {block.text}
              </MessageResponse>
            );
          }

          if (block.kind === "file") {
            return <MessageAttachment key={block.key} part={block.part} />;
          }

          const p = block.part;
          const name = getToolName(p);
          const approval = (p as Record<string, unknown>).approval as
            | { id: string; approved?: boolean }
            | undefined;

          // Blueprint tool calls → compact inline marker
          if (name === "design_app_blueprint") {
            if (p.state === "input-available" || p.state === "input-streaming") {
              return (
                <div key={p.toolCallId} className="flex items-center gap-2 py-1 my-1">
                  <HugeiconsIcon icon={PackageOpenIcon} size={12} className="text-status-warning/60 animate-pulse shrink-0" />
                  <span className="text-xs text-muted-foreground">Updating blueprint...</span>
                </div>
              );
            }
            const input = p.input as Record<string, unknown> | undefined;
            if (p.state === "output-available" && input) {
              return <BlueprintMarker key={p.toolCallId} input={input} />;
            }
            return null;
          }

          if (name === "launch_claude_code") {
            const raw = p.output;
            const output: Record<string, unknown> =
              raw == null
                ? {}
                : typeof raw === "string"
                  ? (() => { try { return JSON.parse(raw); } catch { return {}; } })()
                  : (raw as Record<string, unknown>);

            return (
              <div key={p.toolCallId} className="space-y-2">
                <Tool>
                  <ToolHeader
                    type={p.type}
                    state={p.state}
                    toolName={p.toolName}
                  />
                </Tool>
                {p.state === "output-available" && (
                  <LaunchTerminalCard output={output} />
                )}
              </div>
            );
          }

          return (
            <div key={p.toolCallId} className="space-y-2">
              <Tool>
                <ToolHeader
                  type={p.type}
                  state={p.state}
                  toolName={p.toolName}
                />
                <ToolContent>
                  <ToolInput input={p.input} />
                  <ToolOutput output={p.output} errorText={p.errorText} toolName={name} />
                </ToolContent>
                {name && STREAMING_TOOLS.has(name) && (
                  <LiveToolOutput isRunning={p.state === "input-available"} />
                )}
              </Tool>

              {approval && addToolApprovalResponse && (
                <Confirmation approval={approval} state={p.state}>
                  <ConfirmationRequest>
                    <ConfirmationTitle>
                      Allow Talome to run{" "}
                      <strong>{formatToolName(name)}</strong>?
                    </ConfirmationTitle>
                    <ConfirmationActions>
                      <ConfirmationAction
                        variant="outline"
                        onClick={() =>
                          addToolApprovalResponse({
                            id: approval.id,
                            approved: false,
                            reason: "User denied",
                          })
                        }
                      >
                        Deny
                      </ConfirmationAction>
                      <ConfirmationAction
                        onClick={() =>
                          addToolApprovalResponse({
                            id: approval.id,
                            approved: true,
                          })
                        }
                      >
                        Allow
                      </ConfirmationAction>
                    </ConfirmationActions>
                  </ConfirmationRequest>
                </Confirmation>
              )}
            </div>
          );
        })}
      </MessageContent>

      {message.role === "assistant" && sources.length > 0 && !isStreaming && (
        <MessageSources sources={sources} animateIn={isLast} />
      )}

      {message.role === "assistant" && textContent && (
        <MessageActions className="opacity-100 sm:opacity-0 sm:transition-opacity sm:duration-100 sm:group-hover:opacity-100">
          <MessageAction tooltip="Copy" onClick={handleCopy}>
            {copied ? (
              <HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} />
            ) : (
              <HugeiconsIcon icon={Copy01Icon} size={14} />
            )}
          </MessageAction>
          {isLast && onRegenerate && (
            <MessageAction tooltip="Regenerate" onClick={onRegenerate}>
              <HugeiconsIcon icon={Refresh04Icon} size={14} />
            </MessageAction>
          )}
        </MessageActions>
      )}
    </Message>
  );
}
