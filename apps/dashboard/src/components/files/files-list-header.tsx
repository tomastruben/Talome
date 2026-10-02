"use client";

import { SelectMark } from "@/components/ui/micro";
import { Table, TableHead, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The file list's columns. The header and the body are two tables (the header
 * stays put while the body scrolls under it, with no sticky backdrop), so both
 * take this same colgroup and their columns line up. The first and last
 * columns hold the gutter (`--window-pad`, the classic 0.75rem outside a
 * window) plus the select mark or the row menu.
 */
export function FilesColGroup() {
  return (
    <colgroup>
      <col className="w-[calc(var(--window-pad,0.75rem)+1.5rem)]" />
      <col />
      <col className="hidden w-[25%] @md:table-column" />
      <col className="hidden w-[15%] @md:table-column" />
      <col className="w-[calc(var(--window-pad,0.75rem)+2rem)]" />
    </colgroup>
  );
}

/** Gutter cells: the first and last cells of every row and the header */
export const FILES_FIRST_CELL = "pl-[var(--window-pad,0.75rem)] pr-0";
export const FILES_LAST_CELL = "pl-2 pr-[var(--window-pad,0.75rem)]";

interface FilesListHeaderProps {
  allSelected: boolean;
  /** Something is selected: the select-all mark stays visible */
  hasSelection: boolean;
  onToggleSelectAll: () => void;
}

export function FilesListHeader({ allSelected, hasSelection, onToggleSelectAll }: FilesListHeaderProps) {
  return (
    <Table className="table-fixed" containerClassName="shrink-0 overflow-visible border-b border-border/50">
      <FilesColGroup />
      <thead data-slot="table-header">
        <TableRow className="group/header border-0 hover:bg-transparent [&>th]:h-9 [&>th]:text-xs [&>th]:font-normal [&>th]:text-muted-foreground pointer-coarse:[&>th]:h-11">
          <TableHead className={FILES_FIRST_CELL}>
            <div className="flex items-center justify-center">
              <button
                type="button"
                aria-label={allSelected ? "Deselect all" : "Select all"}
                className={cn(
                  "flex items-center justify-center rounded-full transition-opacity duration-150 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11",
                  // With a mouse the mark appears on hover; on touch there is no hover, so it stays
                  hasSelection
                    ? "opacity-100"
                    : "pointer-fine:opacity-0 pointer-fine:group-hover/header:opacity-100 pointer-fine:focus-visible:opacity-100",
                )}
                onClick={onToggleSelectAll}
              >
                <SelectMark selected={allSelected} className={allSelected ? "text-foreground" : "text-muted-foreground"} />
              </button>
            </div>
          </TableHead>
          <TableHead className="overflow-hidden">Name</TableHead>
          <TableHead className="hidden @md:table-cell">Modified</TableHead>
          <TableHead className="hidden text-right @md:table-cell">Size</TableHead>
          <TableHead className={FILES_LAST_CELL}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </thead>
    </Table>
  );
}
