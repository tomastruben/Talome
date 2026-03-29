"use client";

import { useState } from "react";
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
} from "@/components/icons";
import { ContainerDetailSheet } from "./container-detail-sheet";
import { PillIndicator } from "@/components/kibo-ui/pill";
import { talomePost, talomeDelete } from "@/hooks/use-talome-api";
import { CORE_URL, getHostUrl } from "@/lib/constants";
import { toast } from "sonner";
import type { Container } from "@talome/types";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useSWRConfig } from "swr";
import { useRouter } from "next/navigation";

function formatMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** Strip noisy registry prefixes so "lscr.io/linuxserver/sonarr:4.0" → "sonarr:4.0" */
function shortImage(image: string) {
  return image
    .replace(/^(docker\.io|ghcr\.io|lscr\.io|registry\.hub\.docker\.com)\//i, "")
    .replace(/^(linuxserver|library)\//i, "");
}

interface ContainerTableProps {
  containers: Container[];
}

export function ContainerTable({ containers }: ContainerTableProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const quickLook = useQuickLook();
  const { handleSubmit } = useAssistant();
  const { mutate } = useSWRConfig();
  const router = useRouter();

  const openDetail = (container: Container) => {
    setSelectedContainer(container);
    setDetailOpen(true);
  };

  const handleAction = async (id: string, action: "start" | "stop" | "restart") => {
    const optimisticStatus: Container["status"] =
      action === "start" ? "running" : action === "stop" ? "stopped" : "restarting";
    const key = `${CORE_URL}/api/containers`;
    try {
      setBusyActionId(id);
      await mutate(
        key,
        (current: Container[] = []) =>
          current.map((c) => (c.id === id ? { ...c, status: optimisticStatus } : c)),
        { revalidate: false }
      );
      await talomePost(`/api/containers/${id}/${action}`);
      await mutate(key);
      toast.success(`Container ${action} requested`);
    } catch (err) {
      await mutate(key);
      toast.error(`Failed to ${action} container`);
    } finally {
      setBusyActionId(null);
    }
  };

  const handleRemove = async (container: Container) => {
    const key = `${CORE_URL}/api/containers`;
    setRemovingId(container.id);
    try {
      await mutate(
        key,
        (current: Container[] = []) => current.filter((c) => c.id !== container.id),
        { revalidate: false }
      );
      await talomeDelete(`/api/containers/${container.id}`);
      await mutate(key);
      toast.success(`Removed ${container.name}`);
    } catch (err) {
      await mutate(key);
      toast.error(`Failed to remove ${container.name}`);
    } finally {
      setRemovingId(null);
    }
  };

  const askAssistant = async (container: Container) => {
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
  };

  return (
    <>
      <div className="rounded-lg border overflow-hidden">
        <Table aria-label="Running containers">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col" className="hidden sm:table-cell">Ports</TableHead>
              <TableHead scope="col" className="hidden sm:table-cell text-right">CPU</TableHead>
              <TableHead scope="col" className="text-right">Memory</TableHead>
              <TableHead scope="col" className="w-[100px]"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {containers.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-20 text-center text-sm text-muted-foreground">
                  No containers found
                </TableCell>
              </TableRow>
            )}
            {containers.map((container) => {
              const isRunning = container.status === "running";
              const isRestarting = container.status === "restarting";
              const ports = container.ports.filter(
                (p, i, arr) => arr.findIndex((x) => x.host === p.host) === i
              );

              const statusVariant =
                isRunning ? "success" :
                isRestarting ? "warning" :
                container.status === "paused" ? "info" :
                "error";

              return (
                <TableRow key={container.id}>
                  {/* Identity: status indicator + name + image */}
                  <TableCell>
                    <button
                      type="button"
                      aria-label={`View details for ${container.name}`}
                      className="flex items-start gap-2.5 min-w-0 text-left hover:opacity-75 transition-opacity"
                      onClick={() => openDetail(container)}
                    >
                      <span className="mt-1">
                        <PillIndicator variant={statusVariant} pulse={isRestarting} />
                      </span>
                      <div className="min-w-0">
                        <p className="container-name">{container.name}</p>
                        <p className="container-image">{shortImage(container.image)}</p>
                      </div>
                    </button>
                  </TableCell>

                  {/* Ports */}
                  <TableCell className="hidden sm:table-cell">
                    {ports.length === 0 ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {ports.map((p) =>
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
                          )
                        )}
                      </div>
                    )}
                  </TableCell>

                  {/* CPU */}
                  <TableCell className="hidden sm:table-cell text-right text-sm tabular-nums font-mono text-muted-foreground">
                    {container.stats ? `${container.stats.cpuPercent.toFixed(1)}%` : "—"}
                  </TableCell>

                  {/* Memory */}
                  <TableCell className="text-right text-sm tabular-nums font-mono text-muted-foreground">
                    {container.stats ? formatMb(container.stats.memoryUsageMb) : "—"}
                  </TableCell>

                  {/* Actions */}
                  <TableCell>
                    <div className="row-actions justify-end gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={busyActionId === container.id || removingId === container.id}
                            aria-label={isRunning ? `Stop ${container.name}` : `Start ${container.name}`}
                            onClick={() => handleAction(container.id, isRunning ? "stop" : "start")}
                          >
                            <HugeiconsIcon icon={isRunning ? StopIcon : PlayIcon} size={14} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{isRunning ? "Stop" : "Start"}</TooltipContent>
                      </Tooltip>
                      {isRunning && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              disabled={busyActionId === container.id || removingId === container.id}
                              aria-label={`Restart ${container.name}`}
                              onClick={() => handleAction(container.id, "restart")}
                            >
                              <HugeiconsIcon icon={RefreshDotIcon} size={14} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Restart</TooltipContent>
                        </Tooltip>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground"
                            aria-label={`More actions for ${container.name}`}
                          >
                            <HugeiconsIcon icon={MoreHorizontalIcon} size={15} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openDetail(container)}>
                            <HugeiconsIcon icon={InformationCircleIcon} size={15} />
                            <span>Details</span>
                          </DropdownMenuItem>
                          {isRunning && container.ports.some((p) => p.protocol === "tcp" && p.host > 0) && (
                            <>
                              <DropdownMenuItem onClick={() => quickLook.open(container)}>
                                <HugeiconsIcon icon={ExpandIcon} size={15} />
                                <span>Quick Look</span>
                              </DropdownMenuItem>
                              {container.ports
                                .filter((p) => p.protocol === "tcp" && p.host > 0)
                                .filter((p, i, arr) => arr.findIndex((x) => x.host === p.host) === i)
                                .map((p) => (
                                  <DropdownMenuItem key={p.host} asChild>
                                    <a href={getHostUrl(p.host)} target="_blank" rel="noopener noreferrer">
                                      <HugeiconsIcon icon={Share04Icon} size={15} />
                                      <span>Open :{p.host}</span>
                                    </a>
                                  </DropdownMenuItem>
                                ))}
                            </>
                          )}
                          <DropdownMenuItem onClick={() => void askAssistant(container)}>
                            <HugeiconsIcon icon={BubbleChatDownload02Icon} size={15} />
                            <span>Ask Assistant</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={busyActionId === container.id || removingId === container.id}
                            onClick={() => handleRemove(container)}
                          >
                            <HugeiconsIcon icon={Delete01Icon} size={15} />
                            <span>Remove</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ContainerDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        container={selectedContainer}
      />
    </>
  );
}
