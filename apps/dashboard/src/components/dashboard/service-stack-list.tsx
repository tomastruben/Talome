"use client";

import Image from "next/image";
import { useState, useCallback, Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  HugeiconsIcon,
  PlayIcon,
  StopIcon,
  RefreshDotIcon,
  MoreHorizontalIcon,
  Delete01Icon,
  ExpandIcon,
  InformationCircleIcon,
  BubbleChatDownload02Icon,
  Share04Icon,
  ArrowDown01Icon,
  Layers01Icon,
  Package01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { ContainerDetailSheet } from "./container-detail-sheet";
import { PillIndicator } from "@/components/kibo-ui/pill";
import { talomePost, talomeDelete } from "@/hooks/use-talome-api";
import { CORE_URL, getHostUrl } from "@/lib/constants";
import { toast } from "sonner";
import type { Container, ServiceStack } from "@talome/types";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useSWRConfig } from "swr";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function shortImage(image: string) {
  return image
    .replace(/@sha256:[a-f0-9]+$/i, "")
    .replace(/^(docker\.io|ghcr\.io|lscr\.io|registry\.hub\.docker\.com)\//i, "")
    .replace(/^(linuxserver|library)\//i, "");
}

// ── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: "running" | "partial" | "stopped" | Container["status"] }) {
  const color =
    status === "running" ? "bg-status-healthy" :
    status === "partial" || status === "restarting" || status === "paused" ? "bg-status-warning" :
    status === "stopped" || status === "exited" ? "bg-status-critical/70" :
    "bg-muted-foreground/40";

  return (
    <span className={cn(
      "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
      color,
    )} />
  );
}

// ── Icon Base ────────────────────────────────────────────────────────────────

function IconBox({
  iconUrl,
  icon,
  fallbackIcon,
  size = "md",
  status,
}: {
  iconUrl?: string | null;
  icon?: string;
  fallbackIcon?: IconSvgElement;
  size?: "sm" | "md";
  status?: "running" | "partial" | "stopped" | Container["status"];
}) {
  const hasRealIcon = iconUrl && !iconUrl.startsWith("file://");
  const sizeClass = size === "sm" ? "size-6 rounded-md text-sm" : "size-9 rounded-lg text-lg";
  const iconSize = size === "sm" ? 12 : 18;
  const FallbackIcon = fallbackIcon ?? Package01Icon;

  return (
    <div className={cn("relative shrink-0", size === "sm" ? "size-6" : "size-9")}>
      <div className={cn(
        "relative bg-muted/60 border border-border/40 flex items-center justify-center overflow-hidden",
        sizeClass,
      )}>
        {hasRealIcon ? (
          <>
            <Image
              src={iconUrl!}
              alt=""
              role="presentation"
              className="object-cover" fill
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                img.style.display = "none";
                img.nextElementSibling?.classList.remove("hidden");
              }}
            />
            <span className="hidden">{icon || "📦"}</span>
          </>
        ) : icon && icon !== "📦" ? (
          <span>{icon}</span>
        ) : (
          <HugeiconsIcon icon={FallbackIcon} size={iconSize} className="text-dim-foreground" />
        )}
      </div>
      {status && <StatusBadge status={status} />}
    </div>
  );
}

// ── Stack Icon ───────────────────────────────────────────────────────────────

function StackIcon({ stack }: { stack: ServiceStack }) {
  return (
    <IconBox
      iconUrl={stack.iconUrl}
      icon={stack.icon}
      fallbackIcon={stack.kind === "compose" ? Layers01Icon : Package01Icon}
      status={stack.status}
    />
  );
}

// ── Container Sub-Icon ───────────────────────────────────────────────────────

function ContainerIcon({ container, stack }: { container: Container; stack: ServiceStack }) {
  const iconInfo = stack.containerIcons?.[container.id];
  return (
    <IconBox
      iconUrl={iconInfo?.iconUrl}
      icon={iconInfo?.icon}
      fallbackIcon={Package01Icon}
      size="sm"
      status={container.status}
    />
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

interface ServiceStackListProps {
  stacks: ServiceStack[];
}

export function ServiceStackList({ stacks }: ServiceStackListProps) {
  // Expanded by default — show all information, hide nothing (Ive: remove obstacles)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"start" | "stop" | "restart" | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmRemoveContainer, setConfirmRemoveContainer] = useState<Container | null>(null);
  const quickLook = useQuickLook();
  const { handleSubmit } = useAssistant();
  const { mutate } = useSWRConfig();
  const router = useRouter();

  const toggleExpand = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openDetail = useCallback((container: Container) => {
    setSelectedContainer(container);
    setDetailOpen(true);
  }, []);

  const handleAction = useCallback(async (id: string, action: "start" | "stop" | "restart") => {
    const key = `${CORE_URL}/api/containers`;
    const groupedKey = `${CORE_URL}/api/containers?grouped=true`;
    try {
      setBusyActionId(id);
      setBusyAction(action);
      await talomePost(`/api/containers/${id}/${action}`);
      await Promise.all([mutate(key), mutate(groupedKey)]);
      toast.success(`Container ${action} requested`);
    } catch {
      await Promise.all([mutate(key), mutate(groupedKey)]);
      toast.error(`Failed to ${action} container`);
    } finally {
      setBusyActionId(null);
      setBusyAction(null);
    }
  }, [mutate]);

  const handleRemove = useCallback(async (container: Container) => {
    const key = `${CORE_URL}/api/containers`;
    const groupedKey = `${CORE_URL}/api/containers?grouped=true`;
    setRemovingId(container.id);
    try {
      await talomeDelete(`/api/containers/${container.id}`);
      await Promise.all([mutate(key), mutate(groupedKey)]);
      toast.success(`Removed ${container.name}`);
    } catch {
      await Promise.all([mutate(key), mutate(groupedKey)]);
      toast.error(`Failed to remove ${container.name}`);
    } finally {
      setRemovingId(null);
    }
  }, [mutate]);

  const askAssistant = useCallback(async (container: Container) => {
    const tcpPorts = container.ports
      .filter((p) => p.protocol === "tcp" && p.host > 0)
      .map((p) => p.host)
      .filter((p, i, arr) => arr.indexOf(p) === i);

    let recentLogs = "";
    try {
      const res = await fetch(`${CORE_URL}/api/containers/${container.id}/logs?tail=50`);
      if (res.ok) recentLogs = await res.text();
    } catch { /* logs are optional context */ }

    const userMessage = [
      `Check on **${container.name}**`,
      ...(recentLogs ? [
        "",
        "```log",
        recentLogs.trim(),
        "```",
      ] : []),
    ].join("\n");

    const systemContext = [
      "Current page: /dashboard/containers",
      `Service: ${container.name} | Status: ${container.status} | Image: ${container.image}`,
      `Container: ${container.id}`,
      tcpPorts.length > 0 ? `Ports: ${tcpPorts.join(", ")}` : null,
    ].filter(Boolean).join("\n");

    void handleSubmit(userMessage, systemContext);
    router.push("/dashboard/assistant");
  }, [handleSubmit, router]);

  const statusVariant = (status: Container["status"]) =>
    status === "running" ? "success" :
    status === "restarting" ? "warning" :
    status === "paused" ? "info" :
    "error";

  const stackStatusVariant = (status: ServiceStack["status"]) =>
    status === "running" ? "success" :
    status === "partial" ? "warning" :
    "error";

  return (
    <>
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-11 pl-3 pr-0"><span className="sr-only">Icon</span></TableHead>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col" className="hidden sm:table-cell w-24">Status</TableHead>
              <TableHead scope="col" className="hidden sm:table-cell text-right w-16">CPU</TableHead>
              <TableHead scope="col" className="text-right w-16 sm:w-20">Memory</TableHead>
              <TableHead scope="col" className="w-14 sm:w-20"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          {stacks.length === 0 ? (
            <TableBody>
              <TableRow>
                <TableCell colSpan={6} className="py-20 text-center text-sm text-muted-foreground">
                  No services found
                </TableCell>
              </TableRow>
            </TableBody>
          ) : (
            <TableBody>
            {stacks.map((stack) => {
              const isExpanded = !collapsedIds.has(stack.id);
              const isMulti = stack.containers.length > 1;
              const primary = stack.primaryContainer;
              const primaryRunning = primary.status === "running";
              const primaryPorts = primary.ports.filter(
                (p, i, arr) => p.protocol === "tcp" && p.host > 0 && arr.findIndex((x) => x.host === p.host) === i,
              );

              return (
                <Fragment key={stack.id}>
                  {/* ── Stack row ──────────────────────────────── */}
                  <TableRow
                    className={cn(
                      "group/stack transition-colors cursor-pointer",
                      isMulti && isExpanded && "border-b-0",
                      !isMulti && (busyActionId === primary.id || removingId === primary.id) && "opacity-50 transition-opacity",
                    )}
                    onClick={() => {
                      if (isMulti) toggleExpand(stack.id);
                      else openDetail(primary);
                    }}
                  >
                    <TableCell className="py-2.5 pl-3 pr-0">
                      <StackIcon stack={stack} />
                    </TableCell>
                    <TableCell className="py-2.5 overflow-hidden">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{stack.name}</p>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {isMulti ? `${stack.totalCount} containers` : shortImage(primary.image)}
                          {stack.category && stack.category !== "other" ? ` · ${stack.category}` : ""}
                          {stack.kind !== "talome" && !stack.primaryContainer.labels["talome.managed"] && (
                            <span className="text-dim-foreground"> · External</span>
                          )}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell py-2.5">
                      {!isMulti && (busyActionId === primary.id || removingId === primary.id) ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Spinner className="size-3" />
                          <span>
                            {removingId === primary.id
                              ? "Removing…"
                              : busyAction === "stop" ? "Stopping…"
                              : busyAction === "start" ? "Starting…"
                              : "Restarting…"}
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                          <PillIndicator
                            variant={stackStatusVariant(stack.status)}
                            pulse={stack.status === "running"}
                          />
                          {isMulti
                            ? `${stack.runningCount}/${stack.totalCount}`
                            : <span className="capitalize">{primary.status}</span>
                          }
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell py-2.5 text-right text-sm tabular-nums font-mono text-muted-foreground">
                      {stack.cpuPercent > 0 ? `${stack.cpuPercent.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="py-2.5 text-right text-sm tabular-nums font-mono text-muted-foreground">
                      {stack.memoryUsageMb > 0 ? formatMb(stack.memoryUsageMb) : "—"}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        {/* Quick Look for single-container apps with web ports */}
                        {!isMulti && primaryRunning && primaryPorts.length > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 sm:opacity-0 sm:group-hover/stack:opacity-100 transition-opacity"
                                onClick={(e) => { e.stopPropagation(); quickLook.open(primary); }}
                                aria-label="Quick Look"
                              >
                                <HugeiconsIcon icon={ExpandIcon} size={14} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Quick Look</TooltipContent>
                          </Tooltip>
                        )}

                        {/* Expand chevron for multi-container stacks */}
                        {isMulti && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={(e) => { e.stopPropagation(); toggleExpand(stack.id); }}
                            aria-label={isExpanded ? "Collapse containers" : "Expand containers"}
                          >
                            <HugeiconsIcon
                              icon={ArrowDown01Icon}
                              size={14}
                              className={cn(
                                "stack-chevron text-muted-foreground",
                                isExpanded && "rotate-180",
                              )}
                            />
                          </Button>
                        )}

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={(e) => e.stopPropagation()}
                              aria-label="More actions"
                            >
                              <HugeiconsIcon icon={MoreHorizontalIcon} size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openDetail(primary)}>
                              <HugeiconsIcon icon={InformationCircleIcon} size={15} />
                              <span>Details</span>
                            </DropdownMenuItem>
                            {!isMulti && primaryRunning && primaryPorts.length > 0 && (
                              <>
                                <DropdownMenuItem onClick={() => quickLook.open(primary)}>
                                  <HugeiconsIcon icon={ExpandIcon} size={15} />
                                  <span>Quick Look</span>
                                </DropdownMenuItem>
                                {primaryPorts.map((p) => (
                                  <DropdownMenuItem key={p.host} asChild>
                                    <a href={getHostUrl(p.host)} target="_blank" rel="noopener noreferrer">
                                      <HugeiconsIcon icon={Share04Icon} size={15} />
                                      <span>Open :{p.host}</span>
                                    </a>
                                  </DropdownMenuItem>
                                ))}
                              </>
                            )}
                            <DropdownMenuItem onClick={() => void askAssistant(primary)}>
                              <HugeiconsIcon icon={BubbleChatDownload02Icon} size={15} />
                              <span>Ask Assistant</span>
                            </DropdownMenuItem>
                            {stack.appId && stack.storeId && (
                              <DropdownMenuItem
                                onClick={() => router.push(`/dashboard/apps/${stack.storeId}/${stack.appId}`)}
                              >
                                <HugeiconsIcon icon={Package01Icon} size={15} />
                                <span>View app</span>
                              </DropdownMenuItem>
                            )}
                            {!isMulti && (
                              <>
                                <DropdownMenuSeparator />
                                {primaryRunning ? (
                                  <>
                                    <DropdownMenuItem
                                      disabled={busyActionId === primary.id}
                                      onClick={() => void handleAction(primary.id, "restart")}
                                    >
                                      <HugeiconsIcon icon={RefreshDotIcon} size={15} />
                                      <span>Restart</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={busyActionId === primary.id}
                                      onClick={() => void handleAction(primary.id, "stop")}
                                    >
                                      <HugeiconsIcon icon={StopIcon} size={15} />
                                      <span>Stop</span>
                                    </DropdownMenuItem>
                                  </>
                                ) : (
                                  <DropdownMenuItem
                                    disabled={busyActionId === primary.id}
                                    onClick={() => void handleAction(primary.id, "start")}
                                  >
                                    <HugeiconsIcon icon={PlayIcon} size={15} />
                                    <span>Start</span>
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  disabled={busyActionId === primary.id || removingId === primary.id}
                                  onClick={() => setConfirmRemoveContainer(primary)}
                                >
                                  <HugeiconsIcon icon={Delete01Icon} size={15} />
                                  <span>Remove</span>
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>

                  {/* ── Child containers (animated expand/collapse) ── */}
                  {isMulti && (
                    <tr>
                      <td colSpan={6} className="p-0 border-0">
                        <div
                          className={cn(
                            "grid transition-[grid-template-rows] duration-200 ease-out",
                            isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                          )}
                        >
                          <div className="overflow-hidden min-h-0">
                            <div className="divide-y divide-border/30 bg-muted/10 border-b border-border">
                              {stack.containers.map((container) => {
                                const isRunning = container.status === "running";
                                const ports = container.ports.filter(
                                  (p, i, arr) => p.protocol === "tcp" && p.host > 0 && arr.findIndex((x) => x.host === p.host) === i,
                                );

                                return (
                                  <div key={container.id} className={cn(
                                    "group/sub flex items-center gap-2.5 px-3 py-1.5 transition-opacity",
                                    (busyActionId === container.id || removingId === container.id) && "opacity-50",
                                  )}>
                                    <div className="flex items-center justify-center w-11 shrink-0">
                                      <ContainerIcon container={container} stack={stack} />
                                    </div>
                                    <button
                                      type="button"
                                      className="flex-1 min-w-0 text-left hover:opacity-75 transition-opacity"
                                      onClick={() => openDetail(container)}
                                    >
                                      <p className="text-sm truncate">{container.name}</p>
                                      <p className="text-xs text-muted-foreground truncate mt-0.5">{shortImage(container.image)}</p>
                                    </button>
                                    <div className="hidden sm:flex flex-wrap gap-1 shrink-0">
                                      {ports.length > 0 ? ports.map((p) =>
                                        isRunning ? (
                                          <button
                                            key={p.host}
                                            type="button"
                                            onClick={() => quickLook.open(container)}
                                            className="port-chip"
                                          >
                                            <HugeiconsIcon icon={Share04Icon} size={10} />
                                            {p.host}
                                          </button>
                                        ) : (
                                          <span key={p.host} className="port-chip port-chip-inactive">
                                            {p.host}
                                          </span>
                                        ),
                                      ) : null}
                                    </div>
                                    <span className="hidden sm:block w-16 text-right text-sm tabular-nums font-mono text-muted-foreground shrink-0">
                                      {container.stats ? `${container.stats.cpuPercent.toFixed(1)}%` : "—"}
                                    </span>
                                    <span className="w-16 sm:w-20 text-right text-sm tabular-nums font-mono text-muted-foreground shrink-0">
                                      {container.stats ? formatMb(container.stats.memoryUsageMb) : "—"}
                                    </span>
                                    <div className="flex items-center justify-end gap-0.5 w-14 sm:w-20 shrink-0">
                                      {(busyActionId === container.id || removingId === container.id) ? (
                                        <Spinner className="size-3.5" />
                                      ) : (
                                        <>
                                          {isRunning && ports.length > 0 && (
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <Button
                                                  variant="ghost"
                                                  size="icon"
                                                  className="h-7 w-7 sm:opacity-0 sm:group-hover/sub:opacity-100 transition-opacity"
                                                  onClick={() => quickLook.open(container)}
                                                  aria-label="Quick Look"
                                                >
                                                  <HugeiconsIcon icon={ExpandIcon} size={14} />
                                                </Button>
                                              </TooltipTrigger>
                                              <TooltipContent>Quick Look</TooltipContent>
                                            </Tooltip>
                                          )}
                                          <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 text-muted-foreground sm:opacity-0 sm:group-hover/sub:opacity-100 transition-opacity"
                                                aria-label="More actions"
                                              >
                                                <HugeiconsIcon icon={MoreHorizontalIcon} size={15} />
                                              </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                              <DropdownMenuItem onClick={() => openDetail(container)}>
                                                <HugeiconsIcon icon={InformationCircleIcon} size={15} />
                                                <span>Details</span>
                                              </DropdownMenuItem>
                                              {isRunning && ports.length > 0 && (
                                                <DropdownMenuItem onClick={() => quickLook.open(container)}>
                                                  <HugeiconsIcon icon={ExpandIcon} size={15} />
                                                  <span>Quick Look</span>
                                                </DropdownMenuItem>
                                              )}
                                              <DropdownMenuItem onClick={() => void askAssistant(container)}>
                                                <HugeiconsIcon icon={BubbleChatDownload02Icon} size={15} />
                                                <span>Ask Assistant</span>
                                              </DropdownMenuItem>
                                              <DropdownMenuSeparator />
                                              {isRunning ? (
                                                <>
                                                  <DropdownMenuItem onClick={() => void handleAction(container.id, "restart")}>
                                                    <HugeiconsIcon icon={RefreshDotIcon} size={15} />
                                                    <span>Restart</span>
                                                  </DropdownMenuItem>
                                                  <DropdownMenuItem onClick={() => void handleAction(container.id, "stop")}>
                                                    <HugeiconsIcon icon={StopIcon} size={15} />
                                                    <span>Stop</span>
                                                  </DropdownMenuItem>
                                                </>
                                              ) : (
                                                <DropdownMenuItem onClick={() => void handleAction(container.id, "start")}>
                                                  <HugeiconsIcon icon={PlayIcon} size={15} />
                                                  <span>Start</span>
                                                </DropdownMenuItem>
                                              )}
                                              <DropdownMenuSeparator />
                                              <DropdownMenuItem
                                                className="text-destructive focus:text-destructive"
                                                onClick={() => setConfirmRemoveContainer(container)}
                                              >
                                                <HugeiconsIcon icon={Delete01Icon} size={15} />
                                                <span>Remove</span>
                                              </DropdownMenuItem>
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            </TableBody>
          )}
        </Table>
      </div>

      <ContainerDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        container={selectedContainer}
      />

      <Dialog open={!!confirmRemoveContainer} onOpenChange={() => setConfirmRemoveContainer(null)}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove container</DialogTitle>
            <DialogDescription>
              This will stop and remove the container. It can be recreated from its image or compose file.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to remove{" "}
            <span className="font-medium text-foreground">{confirmRemoveContainer?.name}</span>?
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemoveContainer(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmRemoveContainer) void handleRemove(confirmRemoveContainer);
                setConfirmRemoveContainer(null);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
