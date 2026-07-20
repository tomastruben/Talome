"use client";

import { useMemo } from "react";
import useSWR from "swr";
import type { DiskMount } from "@talome/types";
import {
  CloudServerIcon,
  ExternalDriveIcon,
  HardDriveIcon,
  HugeiconsIcon,
  type IconSvgElement,
} from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useSystemStats } from "@/hooks/use-system-stats";
import { CORE_URL } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

interface FileRootsResponse {
  allowedRoots?: string[];
}

interface DesktopDrive {
  path: string;
  label: string;
  icon: IconSvgElement;
  detail: string;
}

async function fetchFileRoots(url: string): Promise<FileRootsResponse> {
  const response = await fetch(url);
  if (!response.ok) return { allowedRoots: [] };
  return response.json() as Promise<FileRootsResponse>;
}

function rootLabel(path: string): string {
  if (path.includes(".talome")) return "Talome";
  return path.split("/").filter(Boolean).pop() ?? path;
}

function findMount(path: string, mounts: DiskMount[]): DiskMount | undefined {
  const exact = mounts.find((mount) => mount.mount === path);
  if (exact) return exact;

  let bestMatch: DiskMount | undefined;
  for (const mount of mounts) {
    const prefix = mount.mount === "/" ? "/" : `${mount.mount}/`;
    if (!path.startsWith(prefix)) continue;
    if (!bestMatch || mount.mount.length > bestMatch.mount.length) bestMatch = mount;
  }
  return bestMatch;
}

function driveIcon(path: string, mount?: DiskMount): IconSvgElement {
  if (path.includes(".talome") || mount?.type === "internal") return HardDriveIcon;
  if (mount?.type === "network") return CloudServerIcon;
  return ExternalDriveIcon;
}

interface DesktopDriveIconsProps {
  onOpen: (path: string) => void;
  onHide: () => void;
  selectedPath?: string;
  onSelectionChange: (path?: string) => void;
  disabled?: boolean;
}

export function DesktopDriveIcons({
  onOpen,
  onHide,
  selectedPath,
  onSelectionChange,
  disabled = false,
}: DesktopDriveIconsProps) {
  const { stats } = useSystemStats();
  const { data } = useSWR<FileRootsResponse>(
    `${CORE_URL}/api/files/list`,
    fetchFileRoots,
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );
  const drives = useMemo(() => {
    const mounts = stats?.disk.mounts ?? [];
    const roots = Array.from(new Set(data?.allowedRoots ?? []));
    return roots.map((path): DesktopDrive => {
      const mount = findMount(path, mounts);
      const freeBytes = mount ? Math.max(0, mount.totalBytes - mount.usedBytes) : undefined;
      return {
        path,
        label: rootLabel(path),
        icon: driveIcon(path, mount),
        detail: freeBytes === undefined
          ? path
          : `${formatBytes(freeBytes)} available`,
      };
    });
  }, [data?.allowedRoots, stats?.disk.mounts]);

  if (drives.length === 0) return null;

  return (
    <div
      data-desktop-drive-group
      className={cn(
        "absolute top-6 right-6 z-[1] flex w-24 flex-col items-center gap-4",
        disabled && "pointer-events-none",
      )}
      aria-label="Desktop drives"
      aria-hidden={disabled || undefined}
      inert={disabled}
    >
      {drives.map((drive) => (
        <ContextMenu key={drive.path}>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "group flex w-24 flex-col items-center gap-1.5 rounded-lg px-2 py-1.5 text-center outline-none transition-colors duration-150 hover:bg-muted/35 focus-visible:ring-1 focus-visible:ring-foreground/50",
                selectedPath === drive.path && "bg-muted/55 ring-1 ring-foreground/15",
              )}
              aria-label={`Open ${drive.label} drive`}
              aria-pressed={selectedPath === drive.path}
              title={`${drive.label} — ${drive.detail}`}
              onClick={() => onSelectionChange(drive.path)}
              onDoubleClick={() => onOpen(drive.path)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                onOpen(drive.path);
              }}
            >
              <span className="flex size-14 items-center justify-center rounded-xl border border-border/80 bg-card/85 text-muted-foreground backdrop-blur-sm transition-colors duration-150 group-hover:text-foreground">
                <HugeiconsIcon icon={drive.icon} size={30} strokeWidth={1.25} />
              </span>
              <span className="max-w-full truncate rounded bg-background/70 px-1.5 py-0.5 text-xs font-medium text-foreground backdrop-blur-sm">
                {drive.label}
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="z-[1300] w-48">
            <ContextMenuItem onSelect={() => onOpen(drive.path)}>
              Open
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onHide}>
              Hide Drives
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </div>
  );
}
