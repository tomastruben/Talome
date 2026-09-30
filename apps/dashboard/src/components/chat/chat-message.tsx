"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage, DynamicToolUIPart, FileUIPart, ReasoningUIPart } from "ai";
import { isToolUIPart, getToolName } from "ai";
import Image from "next/image";
import useSWR from "swr";
import { useTheme } from "next-themes";
import { useReducedMotion } from "motion/react";
import { BorderBeam } from "border-beam";
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
import { ReasoningSummary } from "@/components/ai-elements/reasoning";
import { IconSwap } from "@/components/ui/micro";
import { copyText } from "@/components/ui/copy-button";
import { COPY_REVERT_MS } from "@/lib/motion";
import { extractAssistantEntityReferences } from "@/lib/assistant-entity-references";
import { ApprovalCard } from "@/components/trust/approval-card";
import { APPROVALS_URL, trustFetcher, useNowAtDeadline } from "@/components/trust/api";
import {
  effectiveApprovalStatus,
  parseApprovalRequest,
  type ApprovalItem,
  type ApprovalRequest,
} from "@/components/trust/format";
import { useUser } from "@/hooks/use-user";

interface ChatMessageProps {
  message: UIMessage;
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

/**
 * The release's server-issued approval card (`approval_required` tool result →
 * admin-only `/api/approvals/:id/approve`), wrapped in a border beam while the
 * decision is outstanding. The beam goes quiet once the approval is approved,
 * denied, consumed or past its TTL. Consent is never client-side: there is no
 * AI SDK `needsApproval` / `addToolApprovalResponse` path here.
 *
 * The status comes from the same SWR key the card polls, so this adds no
 * extra polling. Under reduced motion there is no beam: the card's own status
 * line says it is waiting.
 */
function BeamedApprovalCard({ output }: { output: unknown }) {
  const request = parseApprovalRequest(output);
  if (!request) return null;
  return <BeamedApprovalCardInner output={output} request={request} />;
}

function BeamedApprovalCardInner({ output, request }: { output: unknown; request: ApprovalRequest }) {
  const { resolvedTheme } = useTheme();
  const reduceMotion = useReducedMotion();
  const { isAdmin } = useUser();
  const { data: live } = useSWR<ApprovalItem>(
    isAdmin ? `${APPROVALS_URL}/${encodeURIComponent(request.approvalId)}` : null,
    trustFetcher,
  );
  const current = live ?? { status: request.approvalStatus, expiresAt: request.expiresAt };
  const now = useNowAtDeadline(current.expiresAt, current.status === "pending");
  const waiting = effectiveApprovalStatus(current, now) === "pending";

  return (
    <BorderBeam
      size="pulse-inner"
      colorVariant="sunset"
      staticColors
      active={waiting && !reduceMotion}
      theme={resolvedTheme === "light" ? "light" : "dark"}
      strength={0.8}
    >
      <ApprovalCard output={output} />
    </BorderBeam>
  );
}

const STREAMING_TOOLS = new Set(["plan_change", "apply_change"]);

function LiveToolOutput({ isRunning }: { isRunning: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRunning) return;

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

    // Reset on the way out, so the next run starts empty and "Connecting…".
    return () => {
      es.close();
      setConnected(false);
      setLines([]);
    };
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
          <span className="text-white/30 motion-safe:animate-pulse">
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
    case "research": {
      const research = input.research as {
        useCases?: unknown[];
        githubQueries?: unknown[];
        libraryNeeds?: unknown[];
      } | undefined;
      label = `Planned ${research?.useCases?.length ?? 0} use cases · ${research?.githubQueries?.length ?? 0} GitHub queries · ${research?.libraryNeeds?.length ?? 0} library needs`;
      break;
    }
    case "design": {
      const design = input.experienceDesign as {
        workflows?: unknown[];
        screens?: unknown[];
      } | undefined;
      label = `Designed ${design?.workflows?.length ?? 0} workflows · ${design?.screens?.length ?? 0} screens`;
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

  const entityReferences = useMemo(
    () => extractAssistantEntityReferences(
      message.parts
        .filter(isToolUIPart)
        .map((part) => ({
          toolName: getToolName(part),
          input: part.input,
          output: part.output,
        }))
        .filter((result) => result.toolName.length > 0),
    ),
    [message.parts],
  );

  const handleCopy = useCallback(async () => {
    if (!textContent) return;
    // copyText falls back where the Clipboard API is missing (plain-http LAN).
    if (!(await copyText(textContent))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_REVERT_MS);
  }, [textContent]);

  // Group consecutive text parts
  type RenderBlock =
    | { kind: "text"; key: string; text: string; toolContextNames: string[] }
    | { kind: "reasoning"; key: string; text: string; state: ReasoningUIPart["state"] }
    | { kind: "file"; key: string; part: FileUIPart }
    | { kind: "tool"; key: string; part: DynamicToolUIPart };

  const blocks: RenderBlock[] = [];
  const hasDisplayableReasoning = message.parts.some(
    (part) => part.type === "reasoning" && part.text.trim().length > 0,
  );
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
    } else if (part.type === "reasoning") {
      // Some providers emit an empty completed reasoning part before the part
      // containing the displayable summary. Keep empty-only legacy messages
      // informative, but avoid showing a redundant status row beside a summary.
      if (
        hasDisplayableReasoning &&
        part.state === "done" &&
        part.text.trim().length === 0
      ) {
        continue;
      }
      // Consecutive reasoning parts read as one "Thinking → Thought for Ns" row.
      const last = blocks[blocks.length - 1];
      if (last?.kind === "reasoning") {
        if (part.text.trim()) {
          last.text = last.text.trim() ? `${last.text}\n\n${part.text}` : part.text;
        }
        last.state = part.state;
      } else {
        blocks.push({
          kind: "reasoning",
          key: `reasoning-${blocks.length}`,
          text: part.text,
          state: part.state,
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
              <MessageResponse
                key={block.key}
                toolContextNames={block.toolContextNames}
                entityReferences={entityReferences}
              >
                {block.text}
              </MessageResponse>
            );
          }

          if (block.kind === "file") {
            return <MessageAttachment key={block.key} part={block.part} />;
          }

          if (block.kind === "reasoning") {
            return (
              <ReasoningSummary
                key={block.key}
                text={block.text}
                state={block.state}
                isMessageStreaming={isStreaming}
              />
            );
          }

          const p = block.part;
          const name = getToolName(p);

          // Blueprint tool calls → compact inline marker
          if (name === "design_app_blueprint") {
            if (p.state === "input-available" || p.state === "input-streaming") {
              return (
                <div key={p.toolCallId} className="flex items-center gap-2 py-1 my-1">
                  <HugeiconsIcon icon={PackageOpenIcon} size={12} className="text-status-warning/60 motion-safe:animate-pulse shrink-0" />
                  <span className="text-xs text-muted-foreground">Updating blueprint…</span>
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
                  <ToolOutput output={p.output} errorText={p.errorText} toolName={name} stale={!isLast} />
                </ToolContent>
                {name && STREAMING_TOOLS.has(name) && (
                  <LiveToolOutput isRunning={p.state === "input-available"} />
                )}
              </Tool>
              {p.state === "output-available" && <BeamedApprovalCard output={p.output} />}
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
            <IconSwap
              active={copied ? "b" : "a"}
              a={<HugeiconsIcon icon={Copy01Icon} size={14} />}
              b={<HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} />}
            />
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
