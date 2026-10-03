"use client";

import { WindowStatusBar } from "@/components/desktop/window-content";
import type { PathSegment } from "@/components/files/file-helpers";
import { cn } from "@/lib/utils";

interface FilesStatusBarProps {
  /** The folder's path from its location ("Talome Files / Photos / 2025") */
  segments: PathSegment[];
  /** At the list of locations, the path reads "All locations" */
  atVirtualRoot: boolean;
  onNavigate: (path: string) => void;
  /** "12 items", "3 of 12 items", "37 results"; omitted when there's nothing to count */
  countLabel?: string | null;
  /** A search is running: the count reads "Searching…" with a working dot */
  searching?: boolean;
  showHidden: boolean;
  onToggleHidden: () => void;
}

const segmentClass =
  "inline-flex h-6 max-w-36 items-center truncate rounded-full px-1.5 text-xs text-muted-foreground pointer-coarse:h-11";
const interactiveClass =
  "transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * The Files status bar: where you are (each folder a button back up), how
 * many items are showing, and whether hidden files are. In a desktop window it
 * sits on the window's bottom edge; in classic mode under the list.
 */
export function FilesStatusBar({
  segments,
  atVirtualRoot,
  onNavigate,
  countLabel,
  searching = false,
  showHidden,
  onToggleHidden,
}: FilesStatusBarProps) {
  return (
    <WindowStatusBar className="flex min-h-9 shrink-0 items-center gap-2 border-t border-border/60 px-[var(--window-pad,0.75rem)] text-xs text-muted-foreground">
      <nav
        aria-label="Folder path"
        className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]"
      >
        <ol className="flex items-center">
          {atVirtualRoot || segments.length === 0 ? (
            <li className="flex shrink-0 items-center">
              <span aria-current="page" className={cn(segmentClass, "font-medium")}>
                {atVirtualRoot ? "All locations" : "Files"}
              </span>
            </li>
          ) : (
            segments.map((segment, index) => {
              const isLast = index === segments.length - 1;
              return (
                <li key={segment.path} className="flex shrink-0 items-center">
                  {index > 0 && (
                    <span aria-hidden="true" className="px-0.5 text-muted-foreground select-none">
                      /
                    </span>
                  )}
                  {isLast ? (
                    <span aria-current="page" className={cn(segmentClass, "font-medium")} title={segment.name}>
                      {segment.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={cn(segmentClass, interactiveClass)}
                      title={segment.name}
                      onClick={() => onNavigate(segment.path)}
                    >
                      {segment.name}
                    </button>
                  )}
                </li>
              );
            })
          )}
        </ol>
      </nav>

      {searching ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-status-info motion-safe:animate-breathe" />
          Searching…
        </span>
      ) : countLabel ? (
        <span className="shrink-0 tabular-nums">{countLabel}</span>
      ) : null}

      <button
        type="button"
        aria-pressed={showHidden}
        onClick={onToggleHidden}
        title={showHidden ? "Hide hidden files" : "Show hidden files"}
        className={cn(
          "inline-flex h-6 shrink-0 items-center rounded-full px-1.5 text-xs pointer-coarse:h-11",
          interactiveClass,
          showHidden ? "bg-foreground/10 text-foreground" : "text-muted-foreground",
        )}
      >
        Hidden files
      </button>
    </WindowStatusBar>
  );
}
