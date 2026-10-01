"use client";

import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import {
  HugeiconsIcon,
  Download01Icon,
  FileAttachmentIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  Search01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingPhase } from "@/components/data-state/data-state";
import {
  SEARCH_MIN_CHARS,
  displaySegments,
  fileIcon,
  formatDate,
  highlightRanges,
  isPreviewable,
  parentPath,
  searchErrorCopy,
  searchTruncationNote,
  type FileItem,
} from "@/components/files/file-helpers";
import type { FileSearch } from "@/components/files/use-file-search";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A name with the parts that match the query marked. */
export function HighlightedName({ name, query }: { name: string; query: string }) {
  const ranges = highlightRanges(name, query);
  if (ranges.length === 0) return <>{name}</>;
  const text = name.normalize("NFC");
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], index) => {
    if (start > at) parts.push(<Fragment key={`t${index}`}>{text.slice(at, start)}</Fragment>);
    parts.push(
      <mark key={`m${index}`} className="bg-transparent font-medium text-foreground">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

interface ResultAction {
  id: string;
  label: string;
  icon: IconSvgElement;
  run: () => void;
}

function resultActions(
  item: FileItem,
  handlers: Pick<FileSearchResultsProps, "onOpen" | "onShowInFolder" | "onDownload">,
): ResultAction[] {
  return [
    ...(item.isDirectory || isPreviewable(item.name)
      ? [{
          id: "open",
          label: item.isDirectory ? "Open" : "Quick Look",
          icon: item.isDirectory ? FolderOpenIcon : FileAttachmentIcon,
          run: () => handlers.onOpen(item),
        }]
      : []),
    { id: "reveal", label: "Show in folder", icon: FolderOpenIcon, run: () => handlers.onShowInFolder(item) },
    ...(!item.isDirectory
      ? [{ id: "download", label: "Download", icon: Download01Icon, run: () => handlers.onDownload(item) }]
      : []),
  ];
}

interface FileSearchResultsProps {
  search: FileSearch;
  /** The query as typed (trimmed) */
  query: string;
  /** What is searched: "Photos", "all locations" */
  locationLabel: string;
  /** Every location searched (no folder): copy drops "and its subfolders" */
  everywhere: boolean;
  /** Locations with their labels, for each result's folder path */
  roots: ReadonlyArray<{ path: string; label: string }>;
  showHidden: boolean;
  /** "Search all of Talome Files" when nothing matched below a subfolder */
  widen?: { label: string; onSelect: () => void } | null;
  onIncludeHidden: () => void;
  onOpen: (item: FileItem) => void;
  onShowInFolder: (item: FileItem) => void;
  onDownload: (item: FileItem) => void;
  /** Escape in the list goes back to the search field */
  onExitToField: () => void;
  listRef?: Ref<HTMLDivElement>;
}

/** The grid's id, for the search field's `aria-controls`. */
export const SEARCH_RESULTS_ID = "files-results-list";

/** Grid columns: the result itself, then its actions menu. */
type Column = 0 | 1;

/**
 * Results of a search below a folder: a grid the search field controls. Each
 * row has two cells, the result (named by its name and folder, described by
 * its date and size) and its actions menu, so no control sits inside another.
 * Up and Down move between rows in the same column, Left and Right between a
 * row's cells, Home and End to a row's first and last cell (with Ctrl or ⌘,
 * the first and last row). Results open (folders) or Quick Look (files), and
 * can be shown in their folder or downloaded; renaming, moving and deleting
 * happen in the folder itself.
 */
export function FileSearchResults({
  search,
  query,
  locationLabel,
  everywhere,
  roots,
  showHidden,
  widen,
  onIncludeHidden,
  onOpen,
  onShowInFolder,
  onDownload,
  onExitToField,
  listRef,
}: FileSearchResultsProps) {
  const { result, stale, error, searching, runNow } = search;
  const phase = useLoadingPhase(searching && !result);
  // The roving cell, per result list: a new list starts at its first row.
  const [active, setActive] = useState<{ result: typeof result; index: number; column: Column }>({ result: null, index: 0, column: 0 });
  const activeIndex = active.result === result ? active.index : 0;
  const activeColumn: Column = active.result === result ? active.column : 0;
  const setActiveCell = (index: number, column: Column) => setActive({ result, index, column });
  const resultCellRefs = useRef<Array<HTMLDivElement | null>>([]);
  const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const items = result?.items ?? [];
  const where = everywhere ? locationLabel : `${locationLabel} and its subfolders`;

  if (query.length < SEARCH_MIN_CHARS) {
    return (
      <EmptyState
        fill
        icon={Search01Icon}
        title="Keep typing to search"
        description={`Type at least ${SEARCH_MIN_CHARS} characters to search ${where}.`}
      />
    );
  }

  if (error) {
    const copy = searchErrorCopy(error.status, error.message, locationLabel, error.code);
    return <ErrorState fill title={copy.title} description={copy.description} onRetry={runNow} />;
  }

  if (!result) {
    return phase === "skeleton" ? <SearchResultsSkeleton /> : <div className="min-h-64 flex-1" aria-busy="true" />;
  }

  if (items.length === 0) {
    return (
      <div className={cn("flex flex-1 flex-col transition-opacity duration-150", stale && "opacity-60")} aria-busy={stale || undefined}>
        <EmptyState
          fill
          icon={Search01Icon}
          title={`Nothing matches “${result.query}”`}
          description={`No file or folder in ${where} has that name.${showHidden ? "" : " Hidden files aren't searched."}`}
          action={
            widen || !showHidden ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {widen && (
                  <Button variant="outline" size="sm" onClick={widen.onSelect}>
                    {widen.label}
                  </Button>
                )}
                {!showHidden && (
                  <Button variant="ghost" size="sm" onClick={onIncludeHidden}>
                    Include hidden files
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
      </div>
    );
  }

  const focusCell = (index: number, column: Column) => {
    const next = Math.max(0, Math.min(items.length - 1, index));
    setActiveCell(next, column);
    (column === 0 ? resultCellRefs.current[next] : actionRefs.current[next])?.focus();
  };

  const open = (item: FileItem) => {
    if (item.isDirectory || isPreviewable(item.name)) onOpen(item);
    else onShowInFolder(item);
  };

  const onCellKeyDown = (event: KeyboardEvent<HTMLElement>, index: number, column: Column, item: FileItem) => {
    const toEdge = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case "ArrowDown":
        // On the actions button too: Down moves through the grid, Enter or Space opens the menu.
        event.preventDefault();
        focusCell(index + 1, column);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (index === 0) onExitToField();
        else focusCell(index - 1, column);
        break;
      case "ArrowRight":
        event.preventDefault();
        focusCell(index, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusCell(index, 0);
        break;
      case "Home":
        event.preventDefault();
        focusCell(toEdge ? 0 : index, 0);
        break;
      case "End":
        event.preventDefault();
        focusCell(toEdge ? items.length - 1 : index, 1);
        break;
      case "Enter":
        // The actions button opens its menu on Enter itself.
        if (column !== 0) break;
        event.preventDefault();
        open(item);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onExitToField();
        break;
      default:
        break;
    }
  };

  const note = searchTruncationNote(result);
  const shownQuery = result.query;

  return (
    <div className={cn("flex flex-col transition-opacity duration-150", stale && "opacity-60")} aria-busy={stale || undefined}>
      <div
        ref={listRef}
        role="grid"
        id={SEARCH_RESULTS_ID}
        aria-label={`Results for “${shownQuery}”`}
        className="flex flex-col py-1"
      >
        {items.map((item, index) => {
          const { icon, color } = fileIcon(item);
          const folder = displaySegments(parentPath(item.path), roots).map((segment) => segment.name).join(" / ");
          const actions = resultActions(item, { onOpen, onShowInFolder, onDownload });
          const rowActive = index === activeIndex;
          const cellId = `files-result-${index}`;
          // No modified time means the server couldn't read the item's details in time.
          const known = item.modified !== null;
          const size = item.isDirectory || !known ? null : formatBytes(item.size);
          // Read after the name, like the date and size columns beside it.
          const details = [known ? formatDate(item.modified) : null, size].filter(Boolean).join(", ");
          return (
            <ContextMenu key={item.path}>
              <ContextMenuTrigger asChild>
                <div
                  role="row"
                  data-file-path={item.path}
                  className="group flex min-h-12 items-stretch transition-colors duration-150 hover:bg-foreground/5 has-[:focus-visible]:bg-foreground/5"
                >
                  <div
                    ref={(node) => {
                      resultCellRefs.current[index] = node;
                    }}
                    role="gridcell"
                    id={cellId}
                    data-search-result="name"
                    tabIndex={rowActive && activeColumn === 0 ? 0 : -1}
                    aria-labelledby={`${cellId}-name ${cellId}-folder`}
                    aria-describedby={details ? `${cellId}-details` : undefined}
                    onFocus={() => setActiveCell(index, 0)}
                    onClick={() => open(item)}
                    onKeyDown={(event) => onCellKeyDown(event, index, 0, item)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1.5 pl-[var(--window-pad,0.75rem)] pr-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <HugeiconsIcon icon={icon} size={18} aria-hidden="true" className={cn("shrink-0", color)} />
                    <div className="min-w-0 flex-1">
                      <p id={`${cellId}-name`} className="truncate text-sm text-foreground">
                        <HighlightedName name={item.name} query={shownQuery} />
                      </p>
                      <p id={`${cellId}-folder`} className="truncate text-xs text-muted-foreground">{folder}</p>
                    </div>
                    {details && <span id={`${cellId}-details`} className="sr-only">{details}</span>}
                    <span aria-hidden="true" className="hidden w-24 shrink-0 text-xs text-muted-foreground @md:block">{formatDate(item.modified)}</span>
                    <span aria-hidden="true" className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground @md:block">
                      {size ?? "—"}
                    </span>
                  </div>
                  <div role="gridcell" className="flex shrink-0 items-center pr-[var(--window-pad,0.75rem)]">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        asChild
                        // Arrows move through the grid; Enter and Space open the menu.
                        onKeyDown={(event) => onCellKeyDown(event, index, 1, item)}
                      >
                        <Button
                          ref={(node: HTMLButtonElement | null) => {
                            actionRefs.current[index] = node;
                          }}
                          variant="ghost"
                          size="icon"
                          tabIndex={rowActive && activeColumn === 1 ? 0 : -1}
                          onFocus={() => setActiveCell(index, 1)}
                          className="size-6 shrink-0 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-fine:focus-visible:opacity-100 pointer-fine:data-[state=open]:opacity-100 pointer-coarse:size-11"
                          aria-label={`Actions for ${item.name}`}
                        >
                          <HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        {actions.map((action) => (
                          <DropdownMenuItem key={action.id} onClick={action.run}>
                            <HugeiconsIcon icon={action.icon} size={14} />
                            {action.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                {actions.map((action) => (
                  <ContextMenuItem key={action.id} onClick={action.run}>
                    <HugeiconsIcon icon={action.icon} size={14} />
                    {action.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      {note && (
        <p className="px-[var(--window-pad,0.75rem)] pt-2 pb-4 text-xs text-muted-foreground">{note}</p>
      )}
    </div>
  );
}

function SearchResultsSkeleton() {
  const widths = ["w-40", "w-28", "w-48", "w-32", "w-36", "w-24"];
  return (
    <div className="flex flex-col py-1" aria-busy="true">
      {widths.map((width, index) => (
        <div key={index} className="flex min-h-12 items-center gap-3 px-[var(--window-pad,0.75rem)] py-1.5">
          <Skeleton className="size-5 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn("h-3.5 rounded", width)} />
            <Skeleton className="h-3 w-24 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
