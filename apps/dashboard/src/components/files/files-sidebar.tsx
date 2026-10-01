"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import {
  HugeiconsIcon,
  Archive01Icon,
  AudioBook01Icon,
  Download01Icon,
  ExternalDriveIcon,
  File01Icon,
  Film01Icon,
  Folder01Icon,
  HardDriveIcon,
  Image01Icon,
  LayoutGridIcon,
  MusicNote01Icon,
  PinOffIcon,
  Tv01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SourceList, SourceListItem, SourceListSection } from "@/components/ui/source-list";
import { useSystemStats } from "@/hooks/use-system-stats";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * A Finder-style source list for Files in a desktop window: pinned folders
 * under Favorites, every storage root under Locations. Shown only when Files
 * runs windowed and the window is wide enough; elsewhere the path bar and the
 * locations overview do the job.
 */

const FAVORITES_STORAGE_KEY = "talome-files-favorites-v1";

/** Folders people expect in a sidebar, recognised by name at the top of the main location. */
const WELL_KNOWN_FOLDERS: Record<string, IconSvgElement> = {
  documents: File01Icon,
  downloads: Download01Icon,
  movies: Film01Icon,
  videos: Film01Icon,
  tv: Tv01Icon,
  "tv shows": Tv01Icon,
  music: MusicNote01Icon,
  audiobooks: AudioBook01Icon,
  books: AudioBook01Icon,
  photos: Image01Icon,
  pictures: Image01Icon,
  backups: Archive01Icon,
};

export function folderIcon(path: string): IconSvgElement {
  const name = path.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  return WELL_KNOWN_FOLDERS[name] ?? Folder01Icon;
}

/** Sidebar labels name places, so they start with a capital ("backups" reads "Backups"); the file list keeps real names. */
function folderName(path: string): string {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function readStoredFavorites(): string[] | null {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
  } catch {
    return null;
  }
}

interface ListResponse {
  items?: { name: string; path: string; isDirectory: boolean }[];
}

const listFetcher = (url: string) => fetch(url).then((response) => response.json() as Promise<ListResponse>);

/**
 * Pinned folders. Until someone pins or unpins, the well-known folders at the
 * top of the main location stand in, so the sidebar is useful on first open.
 */
export function useFileFavorites(primaryRoot: string | undefined) {
  const [stored, setStored] = useState<string[] | null>(() => (
    typeof window === "undefined" ? null : readStoredFavorites()
  ));
  const { data } = useSWR<ListResponse>(
    stored === null && primaryRoot
      ? `${CORE_URL}/api/files/list?path=${encodeURIComponent(primaryRoot)}`
      : null,
    listFetcher,
  );
  const suggested = useMemo(
    () => (data?.items ?? [])
      .filter((item) => item.isDirectory && item.name.toLowerCase() in WELL_KNOWN_FOLDERS)
      .map((item) => item.path),
    [data],
  );
  const favorites = stored ?? suggested;

  const persist = useCallback((next: string[]) => {
    setStored(next);
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the sidebar still works for this visit
    }
  }, []);

  const isFavorite = useCallback((path: string) => favorites.includes(path), [favorites]);
  const toggle = useCallback((path: string) => {
    persist(favorites.includes(path)
      ? favorites.filter((entry) => entry !== path)
      : [...favorites, path]);
  }, [favorites, persist]);

  return { favorites, isFavorite, toggle };
}

interface FilesSidebarProps {
  roots: string[];
  currentPath: string | null;
  rootLabel: (root: string) => string;
  favorites: string[];
  onNavigate: (path: string) => void;
  onShowAllLocations?: () => void;
  onUnpin: (path: string) => void;
}

export function FilesSidebar({
  roots,
  currentPath,
  rootLabel,
  favorites,
  onNavigate,
  onShowAllLocations,
  onUnpin,
}: FilesSidebarProps) {
  const { stats } = useSystemStats();
  const mounts = stats?.disk.mounts ?? [];

  const usageFor = (root: string) => {
    const mount = mounts.find((entry) => entry.mount === root)
      ?? mounts
        .filter((entry) => root.startsWith(entry.mount === "/" ? "/" : `${entry.mount}/`))
        .sort((a, b) => b.mount.length - a.mount.length)[0];
    return mount ? Math.round(mount.percent) : null;
  };

  return (
    <SourceList label="Files sidebar">
      {favorites.length > 0 && (
        <SourceListSection title="Favorites">
          {favorites.map((path) => (
            <ContextMenu key={path}>
              <ContextMenuTrigger asChild>
                <div>
                  <SourceListItem
                    iconClassName="text-blue-400/80"
                    icon={folderIcon(path)}
                    label={folderName(path)}
                    active={currentPath === path}
                    onSelect={() => onNavigate(path)}
                    // Unpinning is on the row too, not only in its context
                    // menu: re-pin it from the folder's row menu.
                    action={{
                      icon: PinOffIcon,
                      label: `Remove ${folderName(path)} from sidebar`,
                      onSelect: () => onUnpin(path),
                    }}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => onUnpin(path)}>
                  <HugeiconsIcon icon={PinOffIcon} size={14} />
                  Remove from sidebar
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </SourceListSection>
      )}

      <SourceListSection title="Locations">
        {onShowAllLocations && roots.length > 1 && (
          <SourceListItem
            icon={LayoutGridIcon}
            label="All locations"
            active={currentPath === null}
            onSelect={onShowAllLocations}
          />
        )}
        {roots.map((root) => {
          const usage = usageFor(root);
          const external = /^\/(Volumes|media|mnt|run\/media)\//.test(root);
          return (
            <SourceListItem
              key={root}
              iconClassName="text-blue-400/80"
              icon={external ? ExternalDriveIcon : HardDriveIcon}
              label={rootLabel(root)}
              active={currentPath === root}
              onSelect={() => onNavigate(root)}
              trailing={usage !== null && usage >= 75 ? (
                <span
                  className={cn(
                    "shrink-0 text-xs tabular-nums",
                    usage >= 90 ? "text-destructive" : "text-status-warning",
                  )}
                  title={`${usage}% full`}
                >
                  {usage}%
                </span>
              ) : undefined}
            />
          );
        })}
      </SourceListSection>
    </SourceList>
  );
}
