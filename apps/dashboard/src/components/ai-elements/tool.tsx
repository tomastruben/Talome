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
  Package01Icon,
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
import { useState, isValidElement } from "react";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { terminalCommandAtom } from "@/atoms/terminal";
import { Shimmer } from "@/components/ai-elements/shimmer";

import { CodeBlock } from "./code-block";
import { Pill } from "@/components/kibo-ui/pill";
import { CORE_URL } from "@/lib/constants";

async function containerAction(id: string, action: "start" | "stop" | "restart") {
  await fetch(`${CORE_URL}/api/containers/${id}/${action}`, { method: "POST" });
}

async function requestMedia(mediaId: number | string, mediaType: string) {
  await fetch(`${CORE_URL}/api/media/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, mediaType }),
  });
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
  run_shell: { icon: ComputerTerminal01Icon, tier: "modify" },
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
  read: { bg: "bg-primary/8", text: "text-primary" },
  modify: { bg: "bg-status-warning/10", text: "text-status-warning" },
  destructive: { bg: "bg-destructive/10", text: "text-destructive" },
};

const statusConfig: Record<
  ToolPart["state"],
  { label: string; dot: string; pulse?: boolean }
> = {
  "approval-requested": {
    label: "Awaiting Approval",
    dot: "bg-status-warning",
    pulse: true,
  },
  "approval-responded": { label: "Responded", dot: "bg-status-info" },
  "input-available": { label: "Running", dot: "bg-indigo-400", pulse: true },
  "input-streaming": { label: "Preparing", dot: "bg-muted-foreground/60" },
  "output-available": { label: "Completed", dot: "bg-status-healthy" },
  "output-denied": { label: "Denied", dot: "bg-status-warning" },
  "output-error": { label: "Error", dot: "bg-destructive" },
};

export const getStatusBadge = (status: ToolPart["state"]) => {
  const { label, dot, pulse } = statusConfig[status];
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          dot,
          pulse && "animate-pulse"
        )}
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

  const config = toolIconMap[derivedName] ?? {
    icon: Activity01Icon,
    tier: "read" as ToolTier,
  };
  const { icon, tier } = config;
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

  const config = toolIconMap[derivedName] ?? {
    icon: Activity01Icon,
    tier: "read" as ToolTier,
  };
  const { icon, tier } = config;
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
  const containers = Array.isArray(output) ? output : [];
  if (containers.length === 0) {
    return <p className="text-xs text-muted-foreground py-1">No containers found</p>;
  }
  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {containers.map((c: Record<string, unknown>, i: number) => {
        const isRunning = c.status === "running";
        const id = String(c.id ?? "");
        return (
          <div key={String(c.id ?? i)} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
            <span className={cn("size-1.5 rounded-full shrink-0", isRunning ? "bg-status-healthy" : "bg-status-critical")} />
            <span className="text-xs font-medium text-foreground flex-1 truncate">{String(c.name ?? c.id)}</span>
            <span className="text-xs text-muted-foreground shrink-0 capitalize">{String(c.status ?? "")}</span>
            <div className="flex items-center gap-1 shrink-0">
              {isRunning ? (
                <>
                  <Pill
                    asChild
                    className="cursor-pointer px-2 py-0.5 text-xs h-auto hover:bg-status-warning/10 hover:text-status-warning transition-colors"
                    variant="outline"
                  >
                    <button type="button" onClick={() => containerAction(id, "restart")}>
                      Restart
                    </button>
                  </Pill>
                  <Pill
                    asChild
                    className="cursor-pointer px-2 py-0.5 text-xs h-auto hover:bg-destructive/10 hover:text-destructive transition-colors"
                    variant="outline"
                  >
                    <button type="button" onClick={() => containerAction(id, "stop")}>
                      Stop
                    </button>
                  </Pill>
                </>
              ) : (
                <Pill
                  asChild
                  className="cursor-pointer px-2 py-0.5 text-xs h-auto hover:bg-status-healthy/10 hover:text-status-healthy transition-colors"
                  variant="outline"
                >
                  <button type="button" onClick={() => containerAction(id, "start")}>
                    Start
                  </button>
                </Pill>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
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

function MediaSearchCard({ output }: { output: unknown }) {
  const results = Array.isArray((output as Record<string, unknown>)?.results)
    ? ((output as Record<string, unknown>).results as Record<string, unknown>[])
    : Array.isArray(output) ? (output as Record<string, unknown>[]) : [];
  if (results.length === 0) {
    return <p className="text-xs text-muted-foreground py-1">No results found</p>;
  }
  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {results.slice(0, 6).map((item, i) => (
        <div key={String(item.id ?? i)} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
          <HugeiconsIcon icon={item.mediaType === "tv" ? Tv01Icon : Film01Icon} size={12} className="text-dim-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground flex-1 truncate">{String(item.title ?? item.name ?? "")}</span>
          {item.year !== undefined && item.year !== null && <span className="text-xs text-muted-foreground shrink-0">{String(item.year)}</span>}
          <Pill
            asChild
            className="cursor-pointer px-2 py-0.5 text-xs h-auto hover:bg-primary/10 hover:text-primary transition-colors"
            variant="outline"
          >
            <button
              type="button"
              onClick={() => requestMedia(String(item.id ?? ""), String(item.mediaType ?? "movie"))}
            >
              Request
            </button>
          </Pill>
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
    router.push("/dashboard/terminal");
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
            <HugeiconsIcon icon={Shield01Icon} size={10} />
            Sandboxed
          </span>
        )}
      </div>

      {showWarning && (
        <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 px-3 py-2.5 space-y-2.5">
          <div className="flex items-start gap-2">
            <HugeiconsIcon icon={Shield01Icon} size={14} className="text-status-warning mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-status-warning">Security Notice</p>
              <p className="text-xs text-status-warning/70 mt-0.5 leading-relaxed">
                {!isClaudeCommand
                  ? "This command is not a recognised Claude Code invocation."
                  : "This session may not be scoped to the Talome project directory."}
                {" "}Review the command below before proceeding.
              </p>
            </div>
          </div>
          <div className="rounded-lg bg-[#0d1117] px-3 py-2">
            <code className="text-xs text-[#8b949e] break-all font-mono">{command}</code>
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
              Launch Anyway
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
  const [reverted, setReverted] = useState(false);
  const [loading, setLoading] = useState(false);

  const key = String(output.key ?? "");
  const previousValue = output.previousValue != null ? String(output.previousValue) : null;
  const newValue = String(output.newValue ?? output.restoredValue ?? "");
  const isRevert = String(output.status ?? "") === "ok" && output.restoredValue !== undefined;
  const canUndo = !isRevert && previousValue !== null && !reverted;

  const handleUndo = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${CORE_URL}/api/settings/${encodeURIComponent(key)}/revert`, { method: "POST" });
      if (res.ok) setReverted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <HugeiconsIcon icon={Settings01Icon} size={12} className="text-dim-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground flex-1 truncate">{key}</span>
        {reverted ? (
          <span className="text-xs text-status-healthy shrink-0">Reverted</span>
        ) : canUndo ? (
          <Pill
            asChild
            className="cursor-pointer px-2 py-0.5 text-xs h-auto hover:bg-primary/10 hover:text-primary transition-colors"
            variant="outline"
          >
            <button type="button" onClick={handleUndo} disabled={loading}>
              {loading ? "Undoing…" : "Undo"}
            </button>
          </Pill>
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
  const raw = output as Record<string, unknown> | null;
  const items = Array.isArray(raw?.items) ? (raw!.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return <p className="text-xs text-muted-foreground py-1">No audiobooks found</p>;
  const router = useRouter();
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
            onClick={() => router.push(`/dashboard/audiobooks/${item.id}`)}
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

async function downloadAudiobook(downloadUrl: string, title: string) {
  await fetch(`${CORE_URL}/api/audiobooks/search/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ downloadUrl, title }),
  });
}

const LANG_COLORS: Record<string, string> = {
  CZ: "bg-blue-500/10 text-blue-400",
  SK: "bg-indigo-500/10 text-indigo-400",
  EN: "bg-emerald-500/10 text-emerald-400",
  DE: "bg-amber-500/10 text-amber-400",
};

function AudiobookReleaseCard({ output }: { output: unknown }) {
  const raw = output as Record<string, unknown> | null;
  const releases = Array.isArray(raw?.releases) ? (raw!.releases as Record<string, unknown>[]) : [];
  const [downloaded, setDownloaded] = useState<Set<number>>(new Set());

  if (releases.length === 0) return <p className="text-xs text-muted-foreground py-1">No releases found</p>;

  return (
    <div className="rounded-lg overflow-hidden border border-border/40">
      {releases.slice(0, 6).map((r, i) => {
        const isDownloaded = downloaded.has(i);
        const lang = r.language ? String(r.language) : null;
        return (
          <div key={i} className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t border-border/30")}>
            {lang ? (
              <span className={cn(
                "shrink-0 rounded px-1 py-0.5 text-xs font-medium uppercase tracking-wide",
                LANG_COLORS[lang] ?? "bg-muted/40 text-muted-foreground",
              )}>
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
              <Pill
                asChild
                className={cn(
                  "cursor-pointer px-2 py-0.5 text-xs h-auto transition-colors",
                  isDownloaded
                    ? "bg-status-healthy/10 text-status-healthy cursor-default"
                    : "hover:bg-primary/10 hover:text-primary",
                )}
                variant="outline"
              >
                <button
                  type="button"
                  disabled={isDownloaded}
                  onClick={async () => {
                    await downloadAudiobook(String(r.downloadUrl), String(r.title ?? ""));
                    setDownloaded((prev) => new Set(prev).add(i));
                  }}
                >
                  {isDownloaded ? "Sent" : "Download"}
                </button>
              </Pill>
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
            <span className={cn("size-1.5 rounded-full shrink-0", isComplete ? "bg-status-healthy" : "bg-status-info animate-pulse")} />
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
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  toolName,
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
        <div className={cn("space-y-1.5", className)} {...props}>
          <h4 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Result
          </h4>
          {structured}
        </div>
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
      <h4 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-lg text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/40 text-foreground"
        )}
      >
        {errorText && <div className="px-3 py-2 text-xs">{errorText}</div>}
        {!errorText && Output}
      </div>
    </div>
  );
};
