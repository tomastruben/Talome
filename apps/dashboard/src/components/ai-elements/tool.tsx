"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import type { IconSvgElement } from "@/components/icons";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  HugeiconsIcon,
  Activity01Icon,
  ArrowUp01Icon,
  AudioBook01Icon,
  BookOpen01Icon,
  Calendar01Icon,
  ComputerTerminal01Icon,
  CpuIcon,
  Delete01Icon,
  Download01Icon,
  FileEditIcon,
  Film01Icon,
  Folder01Icon,
  Globe02Icon,
  GridIcon,
  HardDriveIcon,
  HeadphonesIcon,
  Layers01Icon,
  Package02Icon,
  PackageAdd01Icon,
  PackageOpenIcon,
  PackageRemove01Icon,
  PlayIcon,
  Pulse01Icon,
  RepeatIcon,
  Search01Icon,
  Shield01Icon,
  StopIcon,
  SystemUpdate01Icon,
  RamMemoryIcon,
  Wifi01Icon,
  Tv01Icon,
  ArrowDown01Icon,
  Settings01Icon,
} from "@/components/icons";
import { createContext, useContext, useState, isValidElement } from "react";
import Link from "next/link";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { containerHealth, CONTAINER_HEALTH_DOT_CLASS } from "@/lib/container-status";
import type { Container } from "@talome/types";
import { useRouter } from "next/navigation";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import { useSetAtom } from "jotai";
import { terminalCommandAtom } from "@/atoms/terminal";
import { Shimmer } from "@/components/ai-elements/shimmer";

import { CodeBlock } from "./code-block";
import { Button } from "@/components/ui/button";
import { CORE_URL } from "@/lib/constants";

// ── Card actions: one gated path ─────────────────────────────────────────────

/** Tools a card button may run (core routes/tool-actions.ts CARD_ACTIONS). */
export type CardActionTool =
  | "start_container"
  | "stop_container"
  | "restart_container"
  | "request_media"
  | "audiobook_download"
  | "revert_setting";

export interface CardActionResult {
  outcome: "success" | "error" | "blocked" | "approval_required";
  tier?: ToolTier;
  result?: unknown;
  error?: { code?: string; message: string; hint?: string };
  approval?: { approvalId: string; approveUrl: string; expiresAt: string; summary?: string };
}

/**
 * Runs a card button through core's executeTool() (POST /api/chat/actions),
 * so the security mode, approvals and the audit log apply exactly as they do
 * to the same call made by the Assistant. Throws only when the request itself
 * failed; a tool that failed or was held for approval comes back as an outcome.
 */
export async function runCardAction(tool: CardActionTool, args: Record<string, unknown>): Promise<CardActionResult> {
  let res: Response;
  try {
    res = await fetch(`${CORE_URL}/api/chat/actions`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    throw new Error("Couldn't reach the Talome server. Check that it's running, then try again.");
  }
  const body = (await res.json().catch(() => null)) as (CardActionResult & { error?: unknown }) | null;
  if (!res.ok || !body || typeof body.outcome !== "string") {
    const message = body && typeof body.error === "string" ? body.error : `The action didn't run (${res.status}). Try again.`;
    throw new Error(message);
  }
  return body;
}

/** A tool result that reports failure in its own payload ({ success: false, error }). */
function resultFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { success?: unknown; error?: unknown };
  if (r.success === false || typeof r.error === "string") {
    return typeof r.error === "string" && r.error ? r.error : "The tool reported a failure.";
  }
  return null;
}

/** True when the card belongs to an earlier turn, so its data may be out of date. */
const ToolCardStaleContext = createContext(false);

type CardActionState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; message: string }
  | { kind: "approval"; href: string }
  | { kind: "failed"; message: string };

function approvalHref(url: string): string {
  // Core returns an in-app path; never follow anything off-site from a card.
  return url.startsWith("/") && !url.startsWith("//") ? url : "/dashboard/settings/approvals";
}

/**
 * A card button with a real outcome: busy while it runs, then one line that
 * says what happened (done, waiting for approval with a link, or why it
 * failed). On a card from an earlier turn it asks first, because the data it
 * shows may be stale.
 */
function CardActionButton({
  tool,
  args,
  label,
  busyLabel,
  doneMessage,
  confirmTitle,
  className,
}: {
  tool: CardActionTool;
  args: Record<string, unknown>;
  label: string;
  busyLabel: string;
  doneMessage: string;
  /** Question for the stale-card confirmation, e.g. "Restart sonarr?". */
  confirmTitle: string;
  className?: string;
}) {
  const stale = useContext(ToolCardStaleContext);
  const confirm = useConfirm();
  const [state, setState] = useState<CardActionState>({ kind: "idle" });

  const run = async () => {
    if (state.kind === "running") return;
    if (stale) {
      const { confirmed } = await confirm({
        tier: "soft",
        title: confirmTitle,
        consequence: "This card is from earlier in the conversation, so what it shows may have changed since.",
        recovery: "Talome checks your security mode and approvals before it runs, as it would for the Assistant.",
        confirmLabel: label,
      });
      if (!confirmed) return;
    }
    setState({ kind: "running" });
    try {
      const outcome = await runCardAction(tool, args);
      if (outcome.outcome === "approval_required" && outcome.approval) {
        setState({ kind: "approval", href: approvalHref(outcome.approval.approveUrl) });
      } else if (outcome.outcome === "success") {
        const failure = resultFailure(outcome.result);
        setState(failure ? { kind: "failed", message: failure } : { kind: "done", message: doneMessage });
      } else {
        const message = outcome.error
          ? [outcome.error.message, outcome.error.hint].filter(Boolean).join(" ")
          : "The action didn't run.";
        setState({ kind: "failed", message });
      }
    } catch (err) {
      setState({ kind: "failed", message: err instanceof Error ? err.message : "The action didn't run. Try again." });
    }
  };

  if (state.kind === "done") {
    return (
      <span role="status" className="shrink-0 text-xs text-status-healthy">
        {state.message}
      </span>
    );
  }
  if (state.kind === "approval") {
    return (
      <span role="status" className="shrink-0 text-xs text-status-warning">
        Waiting for approval ·{" "}
        <Link href={state.href} className="rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Review
        </Link>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      {state.kind === "failed" ? (
        <span role="alert" className="max-w-48 truncate text-xs text-status-critical" title={state.message}>
          {state.message}
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="xs"
        busy={state.kind === "running"}
        busyLabel={busyLabel}
        onClick={() => void run()}
        className={cn("rounded-full", className)}
      >
        {state.kind === "failed" ? "Retry" : label}
      </Button>
    </span>
  );
}

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "group/tool not-prose mb-2 w-full rounded-xl border border-border/40 bg-card/20 backdrop-blur-sm",
      className
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

type AnyToolPart = DynamicToolUIPart;

type ToolTier = "read" | "modify" | "destructive";

type ToolIconConfig = {
  icon: IconSvgElement;
  tier: ToolTier;
};

const toolIconMap: Record<string, ToolIconConfig> = {
  list_containers: { icon: Layers01Icon, tier: "read" },
  get_container_logs: { icon: FileEditIcon, tier: "read" },
  check_service_health: { icon: Pulse01Icon, tier: "read" },
  get_system_stats: { icon: CpuIcon, tier: "read" },
  get_disk_usage: { icon: HardDriveIcon, tier: "read" },
  list_apps: { icon: GridIcon, tier: "read" },
  search_apps: { icon: Search01Icon, tier: "read" },
  get_library: { icon: BookOpen01Icon, tier: "read" },
  search_media: { icon: Search01Icon, tier: "read" },
  get_downloads: { icon: Download01Icon, tier: "read" },
  get_calendar: { icon: Calendar01Icon, tier: "read" },
  start_container: { icon: PlayIcon, tier: "modify" },
  stop_container: { icon: StopIcon, tier: "modify" },
  restart_container: { icon: RepeatIcon, tier: "modify" },
  install_app: { icon: PackageAdd01Icon, tier: "modify" },
  uninstall_app: { icon: Delete01Icon, tier: "destructive" },
  start_app: { icon: PlayIcon, tier: "modify" },
  stop_app: { icon: StopIcon, tier: "modify" },
  restart_app: { icon: RepeatIcon, tier: "modify" },
  update_app: { icon: SystemUpdate01Icon, tier: "modify" },
  add_store: { icon: PackageOpenIcon, tier: "modify" },
  create_app: { icon: Package02Icon, tier: "modify" },
  request_media: { icon: Film01Icon, tier: "modify" },
  arr_list_quality_profiles: { icon: Film01Icon, tier: "read" },
  arr_apply_quality_profile: { icon: Film01Icon, tier: "modify" },
  arr_get_wanted_missing: { icon: Search01Icon, tier: "read" },
  arr_get_wanted_cutoff: { icon: Search01Icon, tier: "read" },
  arr_search_releases: { icon: Search01Icon, tier: "read" },
  arr_grab_release: { icon: Download01Icon, tier: "modify" },
  arr_get_queue_details: { icon: Download01Icon, tier: "read" },
  arr_queue_action: { icon: RepeatIcon, tier: "modify" },
  arr_cleanup_dry_run: { icon: Delete01Icon, tier: "read" },
  design_app_blueprint: { icon: PackageOpenIcon, tier: "modify" },
  launch_claude_code: { icon: ComputerTerminal01Icon, tier: "destructive" },
  package_uninstall: { icon: PackageRemove01Icon, tier: "destructive" },
  web_search: { icon: Globe02Icon, tier: "read" },
  set_setting: { icon: Settings01Icon, tier: "modify" },
  revert_setting: { icon: Settings01Icon, tier: "modify" },
  get_settings: { icon: Settings01Icon, tier: "read" },
  read_file: { icon: FileEditIcon, tier: "read" },
  list_directory: { icon: Folder01Icon, tier: "read" },
  rollback_file: { icon: RepeatIcon, tier: "modify" },
  run_shell: { icon: ComputerTerminal01Icon, tier: "destructive" },
  audiobookshelf_get_status: { icon: AudioBook01Icon, tier: "read" },
  audiobookshelf_list_libraries: { icon: AudioBook01Icon, tier: "read" },
  audiobookshelf_get_library_items: { icon: AudioBook01Icon, tier: "read" },
  audiobookshelf_search: { icon: Search01Icon, tier: "read" },
  audiobookshelf_get_item: { icon: AudioBook01Icon, tier: "read" },
  audiobookshelf_get_progress: { icon: HeadphonesIcon, tier: "read" },
  audiobookshelf_update_progress: { icon: HeadphonesIcon, tier: "modify" },
  audiobookshelf_add_library: { icon: AudioBook01Icon, tier: "modify" },
  audiobookshelf_scan_library: { icon: AudioBook01Icon, tier: "modify" },
  audiobook_search_releases: { icon: Search01Icon, tier: "read" },
  audiobook_download: { icon: Download01Icon, tier: "modify" },
  audiobook_list_downloads: { icon: Download01Icon, tier: "read" },
  audiobook_request: { icon: AudioBook01Icon, tier: "modify" },
};

const tierStyles: Record<ToolTier, { bg: string; text: string }> = {
  read: { bg: "bg-muted", text: "text-foreground" },
  modify: { bg: "bg-status-warning/12", text: "text-status-warning" },
  destructive: { bg: "bg-status-critical/12", text: "text-status-critical" },
};

/**
 * A tool this card doesn't know is styled as a change ("modify"), never as a
 * harmless read: new or custom tools can write, and the card must not look
 * safer than the call was.
 */
export function toolCardConfig(toolName: string): { icon: IconSvgElement; tier: ToolTier } {
  return toolIconMap[toolName] ?? { icon: Activity01Icon, tier: "modify" };
}

const statusConfig: Record<
  ToolPart["state"],
  { label: string; dot: string; pulse?: boolean }
> = {
  "approval-requested": {
    label: "Waiting for approval",
    dot: "bg-status-warning",
  },
  "approval-responded": { label: "Decided", dot: "bg-status-info" },
  "input-available": { label: "Running", dot: "bg-status-info", pulse: true },
  "input-streaming": { label: "Preparing", dot: "bg-muted-foreground" },
  "output-available": { label: "Completed", dot: "bg-status-healthy" },
  "output-denied": { label: "Denied", dot: "bg-muted-foreground" },
  "output-error": { label: "Failed", dot: "bg-status-critical" },
};

export const getStatusBadge = (status: ToolPart["state"]) => {
  const { label, dot, pulse } = statusConfig[status];
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          dot,
          pulse && "motion-safe:animate-pulse"
        )}
        aria-hidden="true"
      />
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
};

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  const { icon, tier } = toolCardConfig(derivedName);
  const styles = tierStyles[tier];

  const formattedName = (title ?? derivedName)
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const isToolRunning = state === "input-available" || state === "input-streaming";

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-3.5 px-3.5 py-3 text-left",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-xl",
          styles.bg
        )}
      >
        <HugeiconsIcon icon={icon} size={18} className={styles.text} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium leading-none text-foreground">
          {isToolRunning ? (
            <Shimmer as="span" className="text-sm font-medium leading-none" duration={1.8}>
              {formattedName}
            </Shimmer>
          ) : (
            formattedName
          )}
        </span>
        {getStatusBadge(state)}
      </div>

      <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="shrink-0 text-dim-foreground transition-transform group-data-[state=open]/tool:rotate-180" />
    </CollapsibleTrigger>
  );
};

/** Non-collapsible header for artifact tool cards rendered as a simple button. */
export const ToolHeaderInline = ({
  className,
  title,
  type,
  state,
  toolName,
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  const { icon, tier } = toolCardConfig(derivedName);
  const styles = tierStyles[tier];

  const formattedName = (title ?? derivedName)
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <>
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-xl",
          styles.bg,
          className
        )}
      >
        <HugeiconsIcon icon={icon} size={18} className={styles.text} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium leading-none text-foreground">
          {formattedName}
        </span>
        {getStatusBadge(state)}
      </div>
      <HugeiconsIcon icon={ArrowUp01Icon} size={14} className="shrink-0 text-dim-foreground" />
    </>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-3 border-t border-border/30 px-3.5 pb-3.5 pt-3 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: AnyToolPart["input"];
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-1.5 overflow-hidden", className)} {...props}>
    <h4 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
      Parameters
    </h4>
    <div className="rounded-lg bg-muted/40">
      <CodeBlock code={safeStringify(input)} language="json" />
    </div>
  </div>
);

// ── Structured result cards ───────────────────────────────────────────────────

function ContainerListCard({ output }: { output: unknown }) {
  const router = useRouter();
  const containers = Array.isArray(output) ? output : [];
  if (containers.length === 0) {
    return <p className="text-xs text-muted-foreground py-1">No containers found</p>;
  }
  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {containers.map((c: Record<string, unknown>, i: number) => {
        const isRunning = c.status === "running";
        const id = String(c.id ?? "");
        const name = String(c.name ?? c.id ?? "");
        const health = containerHealth({
          status: String(c.status ?? "") as Container["status"],
          exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
        });
        return (
          <div key={String(c.id ?? i)} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
            <span className={cn("size-1.5 rounded-full shrink-0", CONTAINER_HEALTH_DOT_CLASS[health])} aria-hidden="true" />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground hover:text-primary"
              aria-label={`Open ${String(c.name ?? c.id)} in Services`}
              onClick={() => {
                const href = `/dashboard/containers?q=${encodeURIComponent(String(c.name ?? c.id))}`;
                if (!requestDesktopNavigation(href)) router.push(href);
              }}
            >
              {String(c.name ?? c.id)}
            </button>
            <span className="text-xs text-muted-foreground shrink-0 capitalize">{String(c.status ?? "")}</span>
            <div className="flex items-center gap-1 shrink-0">
              {isRunning ? (
                <>
                  <CardActionButton
                    tool="restart_container"
                    args={{ containerId: id }}
                    label="Restart"
                    busyLabel={`Restarting ${name}…`}
                    doneMessage={`Restarted ${name}`}
                    confirmTitle={`Restart ${name}?`}
                  />
                  <CardActionButton
                    tool="stop_container"
                    args={{ containerId: id }}
                    label="Stop"
                    busyLabel={`Stopping ${name}…`}
                    doneMessage={`Stopped ${name}`}
                    confirmTitle={`Stop ${name}?`}
                  />
                </>
              ) : (
                <CardActionButton
                  tool="start_container"
                  args={{ containerId: id }}
                  label="Start"
                  busyLabel={`Starting ${name}…`}
                  doneMessage={`Started ${name}`}
                  confirmTitle={`Start ${name}?`}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type AssistantMediaItem = {
  id: string;
  mediaType: "movie" | "tv";
  title: string;
  year?: string;
  /** Present only when the id is a real TVDB (tv) or TMDB (movie) id, which request_media needs. */
  requestId?: number;
};

function mediaItemsFromToolOutput(output: unknown): AssistantMediaItem[] {
  if (!output || typeof output !== "object") return [];
  const raw = output as Record<string, unknown>;

  if (Array.isArray(raw.results)) {
    return raw.results.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const result = item as Record<string, unknown>;
      const title = String(result.title ?? result.name ?? "").trim();
      const id = String(result.id ?? result.tmdbId ?? result.tvdbId ?? "").trim();
      if (!title || !id) return [];
      return [{
        id,
        mediaType: result.mediaType === "tv" || result.type === "tv" ? "tv" : "movie",
        title,
        year: result.year == null ? undefined : String(result.year),
      } satisfies AssistantMediaItem];
    });
  }

  const tv = Array.isArray(raw.tv) ? raw.tv : [];
  const movies = Array.isArray(raw.movies) ? raw.movies : [];
  return [
    ...tv.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const result = item as Record<string, unknown>;
      const title = String(result.title ?? "").trim();
      const id = String(result.id ?? result.tvdbId ?? "").trim();
      const requestId = typeof result.tvdbId === "number" ? result.tvdbId : undefined;
      return title && id
        ? [{ id, mediaType: "tv" as const, title, year: result.year == null ? undefined : String(result.year), requestId }]
        : [];
    }),
    ...movies.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const result = item as Record<string, unknown>;
      const title = String(result.title ?? "").trim();
      const id = String(result.id ?? result.tmdbId ?? "").trim();
      const requestId = typeof result.tmdbId === "number" ? result.tmdbId : undefined;
      return title && id
        ? [{ id, mediaType: "movie" as const, title, year: result.year == null ? undefined : String(result.year), requestId }]
        : [];
    }),
  ];
}

function mediaLibraryRoute(item: AssistantMediaItem) {
  const params = new URLSearchParams({
    tab: item.mediaType === "tv" ? "tv" : "movies",
    q: item.title,
  });
  return `/dashboard/media?${params.toString()}`;
}

function SystemStatsCard({ output }: { output: unknown }) {
  const s = output as Record<string, Record<string, number>> | null;
  if (!s) return null;
  const items = [
    { icon: CpuIcon,     label: "CPU",    value: `${(s.cpu?.usage ?? 0).toFixed(1)}%` },
    { icon: RamMemoryIcon, label: "Memory", value: `${(s.memory?.percent ?? 0).toFixed(1)}%` },
    { icon: HardDriveIcon, label: "Disk",  value: `${(s.disk?.percent ?? 0).toFixed(1)}%` },
    { icon: Wifi01Icon,  label: "Net ↓",  value: `${((s.network?.rxBytesPerSec ?? 0) / 1024).toFixed(0)} KB/s` },
  ];
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {items.map(({ icon, label, value }) => (
        <div key={label} className="flex items-center gap-2 rounded-lg border border-border/40 px-3 py-2">
          <HugeiconsIcon icon={icon} size={12} className="text-dim-foreground shrink-0" />
          <span className="text-xs text-muted-foreground flex-1">{label}</span>
          <span className="text-xs font-medium tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

function MediaSearchCard({ output, requestable = true }: { output: unknown; requestable?: boolean }) {
  const router = useRouter();
  const results = mediaItemsFromToolOutput(output);
  if (results.length === 0) {
    return <p className="text-xs text-muted-foreground py-1">No results found</p>;
  }
  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {results.slice(0, 6).map((item, i) => (
        <div key={`${item.mediaType}-${item.id}-${i}`} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
          <HugeiconsIcon icon={item.mediaType === "tv" ? Tv01Icon : Film01Icon} size={12} className="text-dim-foreground shrink-0" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-xs font-medium text-foreground hover:text-primary"
            aria-label={`Open ${item.title} in Media`}
            onClick={() => {
              const href = mediaLibraryRoute(item);
              if (!requestDesktopNavigation(href)) router.push(href);
            }}
          >
            {item.title}
          </button>
          {item.year ? <span className="text-xs text-muted-foreground shrink-0">{item.year}</span> : null}
          {requestable && item.requestId !== undefined ? (
            <CardActionButton
              tool="request_media"
              args={item.mediaType === "tv"
                ? { type: "tv", tvdbId: item.requestId, title: item.title }
                : { type: "movie", tmdbId: item.requestId, title: item.title }}
              label="Request"
              busyLabel={`Requesting ${item.title}…`}
              doneMessage="Requested"
              confirmTitle={`Request ${item.title}?`}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function LaunchTerminalCard({ output }: { output: Record<string, unknown> }) {
  const [launched, setLaunched] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const setTerminalCommand = useSetAtom(terminalCommandAtom);
  const router = useRouter();

  const command = String(output.command ?? "");
  const task = String(output.task ?? "");
  const projectRoot = output.projectRoot ? String(output.projectRoot) : null;

  const isClaudeCommand = /\bclaude\b/.test(command);
  const isProjectScoped = projectRoot != null && command.includes(projectRoot);
  const isSafe = isClaudeCommand && isProjectScoped;

  const doLaunch = () => {
    setTerminalCommand(command);
    setLaunched(true);
    setShowWarning(false);
    if (!requestDesktopNavigation("/dashboard/terminal")) {
      router.push("/dashboard/terminal");
    }
  };

  const handleLaunch = () => {
    if (!isSafe) { setShowWarning(true); return; }
    doLaunch();
  };

  return (
    <div className={cn(
      "rounded-xl border p-3.5 space-y-3",
      showWarning ? "border-status-warning/30" : "border-border/40",
    )}>
      <div className="flex items-center gap-2.5">
        <div className={cn(
          "flex size-9 items-center justify-center rounded-xl",
          isSafe ? "bg-primary/8" : "bg-status-warning/8",
        )}>
          <HugeiconsIcon
            icon={isSafe ? ComputerTerminal01Icon : Shield01Icon}
            size={18}
            className={isSafe ? "text-primary" : "text-status-warning"}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-none mb-1">Claude Code session ready</p>
          <p className="text-xs text-muted-foreground truncate">{task}</p>
        </div>
        {isSafe && (
          <span className="flex items-center gap-1 shrink-0 rounded-md bg-status-healthy/8 px-2 py-0.5 text-xs font-medium text-status-healthy">
            <HugeiconsIcon icon={Shield01Icon} size={10} aria-hidden="true" />
            In Talome&apos;s folder
          </span>
        )}
      </div>

      {showWarning && (
        <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 px-3 py-2.5 space-y-2.5">
          <div className="flex items-start gap-2">
            <HugeiconsIcon icon={Shield01Icon} size={14} className="text-status-warning mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-status-warning">Check this command first</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {!isClaudeCommand
                  ? "This command is not a recognised Claude Code invocation."
                  : "This session may not be scoped to the Talome project directory."}
                {" "}Review the command below before proceeding.
              </p>
            </div>
          </div>
          <div className="dark rounded-lg bg-terminal px-3 py-2">
            <code className="text-xs text-terminal-foreground break-all font-mono">{command}</code>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowWarning(false)}
              className="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium bg-muted/40 text-muted-foreground hover:bg-muted/60 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={doLaunch}
              className="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium bg-status-warning/10 text-status-warning hover:bg-status-warning/20 transition-colors cursor-pointer"
            >
              Launch anyway
            </button>
          </div>
        </div>
      )}

      {!showWarning && (
        <button
          type="button"
          disabled={launched}
          onClick={handleLaunch}
          className={cn(
            "w-full rounded-lg px-3 py-2 text-xs font-medium transition-colors",
            launched
              ? "bg-status-healthy/10 text-status-healthy cursor-default"
              : "bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer",
          )}
        >
          {launched ? "Opened in Terminal" : "Open in Terminal"}
        </button>
      )}
    </div>
  );
}

function SettingChangeCard({ output }: { output: Record<string, unknown> }) {
  const key = String(output.key ?? "");
  const previousValue = output.previousValue != null ? String(output.previousValue) : null;
  const newValue = String(output.newValue ?? output.restoredValue ?? "");
  const isRevert = String(output.status ?? "") === "ok" && output.restoredValue !== undefined;
  const canUndo = !isRevert && previousValue !== null;

  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <HugeiconsIcon icon={Settings01Icon} size={12} className="text-dim-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground flex-1 truncate">{key}</span>
        {canUndo ? (
          <CardActionButton
            tool="revert_setting"
            args={{ key }}
            label="Undo"
            busyLabel={`Undoing the change to ${key}…`}
            doneMessage="Undone"
            confirmTitle={`Undo the change to ${key}?`}
          />
        ) : null}
      </div>
      {previousValue !== null && (
        <div className="border-t border-border/30 px-3 py-1.5 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground line-through truncate max-w-[40%]">{previousValue}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={10} className="text-dim-foreground shrink-0 rotate-[-90deg]" />
          <span className="text-foreground truncate">{newValue}</span>
        </div>
      )}
      {previousValue === null && (
        <div className="border-t border-border/30 px-3 py-1.5 text-xs text-foreground truncate">
          {newValue}
        </div>
      )}
    </div>
  );
}

// ── Audiobook structured cards ────────────────────────────────────────────────

function AudiobookLibraryCard({ output }: { output: unknown }) {
  const router = useRouter();
  const raw = output as Record<string, unknown> | null;
  const items = Array.isArray(raw?.items) ? (raw!.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return <p className="text-xs text-muted-foreground py-1">No audiobooks found</p>;
  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {items.slice(0, 8).map((item, i) => {
        const duration = typeof item.duration === "number" ? `${Math.round(item.duration / 3600)}h` : null;
        return (
          <button
            type="button"
            key={String(item.id ?? i)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/30 transition-colors",
              i > 0 && "border-t border-border/30",
            )}
            onClick={() => {
              const href = `/dashboard/audiobooks/${item.id}`;
              if (!requestDesktopNavigation(href)) router.push(href);
            }}
          >
            <HugeiconsIcon icon={AudioBook01Icon} size={12} className="text-dim-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground flex-1 truncate">{String(item.title ?? "")}</span>
            {item.author ? <span className="text-xs text-muted-foreground shrink-0 truncate max-w-[30%]">{String(item.author)}</span> : null}
            {duration && <span className="text-xs text-muted-foreground shrink-0">{duration}</span>}
          </button>
        );
      })}
      {(raw?.total as number) > 8 && (
        <div className="border-t border-border/30 px-3 py-1.5 text-xs text-muted-foreground text-center">
          +{(raw!.total as number) - 8} more
        </div>
      )}
    </div>
  );
}


function AudiobookReleaseCard({ output }: { output: unknown }) {
  const raw = output as Record<string, unknown> | null;
  const releases = Array.isArray(raw?.releases) ? (raw!.releases as Record<string, unknown>[]) : [];

  if (releases.length === 0) return <p className="text-xs text-muted-foreground py-1">No releases found</p>;

  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {releases.slice(0, 6).map((r, i) => {
        const lang = r.language ? String(r.language) : null;
        return (
          <div key={i} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
            {lang ? (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs font-medium text-muted-foreground">
                {lang}
              </span>
            ) : (
              <HugeiconsIcon icon={HeadphonesIcon} size={12} className="text-dim-foreground shrink-0" />
            )}
            <span className="text-xs font-medium text-foreground flex-1 truncate" title={String(r.title ?? "")}>
              {String(r.title ?? "")}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">{String(r.sizeFormatted ?? "")}</span>
            <span className="text-xs text-muted-foreground shrink-0">{String(r.seeders ?? 0)}S</span>
            {r.downloadUrl ? (
              <CardActionButton
                tool="audiobook_download"
                args={{ downloadUrl: String(r.downloadUrl), title: String(r.title ?? "") }}
                label="Download"
                busyLabel="Sending to the download client…"
                doneMessage="Sent"
                confirmTitle={`Download ${String(r.title ?? "this release")}?`}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AudiobookDownloadsCard({ output }: { output: unknown }) {
  const raw = output as Record<string, unknown> | null;
  const downloads = Array.isArray(raw?.downloads) ? (raw!.downloads as Record<string, unknown>[]) : [];
  if (downloads.length === 0) return <p className="text-xs text-muted-foreground py-1">No audiobook downloads</p>;

  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {downloads.slice(0, 6).map((d, i) => {
        const progress = String(d.progress ?? "0%");
        const isComplete = progress === "100%";
        return (
          <div key={String(d.hash ?? i)} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
            <span className={cn("size-1.5 rounded-full shrink-0", isComplete ? "bg-status-healthy" : "bg-status-info motion-safe:animate-pulse")} />
            <span className="text-xs font-medium text-foreground flex-1 truncate">{String(d.name ?? "")}</span>
            <span className="text-xs text-muted-foreground shrink-0">{String(d.size ?? "")}</span>
            <span className={cn("text-xs shrink-0 tabular-nums", isComplete ? "text-status-healthy" : "text-muted-foreground")}>
              {progress}
            </span>
            {!isComplete && d.dlspeed && String(d.dlspeed) !== "0" ? (
              <span className="text-xs text-muted-foreground shrink-0">{String(d.dlspeed)}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function getStructuredCard(toolName: string, output: unknown): ReactNode | null {
  if (toolName === "list_containers") return <ContainerListCard output={output} />;
  if (toolName === "get_system_stats") return <SystemStatsCard output={output} />;
  if (toolName === "search_media") return <MediaSearchCard output={output} />;
  if (toolName === "get_library") return <MediaSearchCard output={output} requestable={false} />;
  if (toolName === "audiobookshelf_get_library_items" || toolName === "audiobookshelf_search") return <AudiobookLibraryCard output={output} />;
  if (toolName === "audiobook_search_releases") return <AudiobookReleaseCard output={output} />;
  if (toolName === "audiobook_list_downloads") return <AudiobookDownloadsCard output={output} />;
  if ((toolName === "set_setting" || toolName === "revert_setting") && output != null && typeof output === "object") {
    return <SettingChangeCard output={output as Record<string, unknown>} />;
  }
  if (toolName === "launch_claude_code" && output != null) {
    const obj = typeof output === "string"
      ? (() => { try { return JSON.parse(output); } catch { return null; } })()
      : output;
    if (obj && typeof obj === "object") {
      return <LaunchTerminalCard output={obj as Record<string, unknown>} />;
    }
  }
  return null;
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: AnyToolPart["output"];
  errorText: AnyToolPart["errorText"];
  toolName?: string;
  /** The card belongs to an earlier turn: its buttons confirm before running. */
  stale?: boolean;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  toolName,
  stale = false,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  // Structured card for known tools
  if (toolName && !errorText && output !== undefined) {
    const structured = getStructuredCard(toolName, output);
    if (structured) {
      return (
        <ToolCardStaleContext.Provider value={stale}>
        <div className={cn("space-y-1.5", className)} {...props}>
          <h4 className="text-xs font-medium text-muted-foreground">
            Result
          </h4>
          {structured}
        </div>
        </ToolCardStaleContext.Provider>
      );
    }
  }

  let Output: ReactNode;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={safeStringify(output)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  } else {
    Output = <div>{String(output)}</div>;
  }

  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <h4 className="text-xs font-medium text-muted-foreground">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-lg text-xs [&_table]:w-full",
          errorText
            ? "bg-status-critical/12 text-foreground"
            : "bg-muted/40 text-foreground"
        )}
      >
        {errorText && <div className="px-3 py-2 text-xs">{errorText}</div>}
        {!errorText && Output}
      </div>
    </div>
  );
};
