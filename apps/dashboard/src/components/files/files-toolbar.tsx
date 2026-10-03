"use client";

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import {
  HugeiconsIcon,
  Cancel01Icon,
  CloudUploadIcon,
  FileUploadIcon,
  FolderAddIcon,
  FolderUploadIcon,
} from "@/components/icons";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { ToolbarGroup, ToolbarGroupButton } from "@/components/desktop/toolbar-group";
import { SEARCH_RESULTS_ID } from "@/components/files/file-search-results";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SHORTCUTS } from "@/lib/keymap";
import { cn } from "@/lib/utils";

export type FilesSearchScope = "folder" | "deep";

interface FilesToolbarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  /** Clears the search and keeps focus in the field */
  onClear: () => void;
  /** Escape, Enter and ArrowDown in the field (the page owns the result list) */
  onFieldKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** What the field searches: "Talome Files", "Photos", "all locations" */
  locationLabel: string;
  scope: FilesSearchScope;
  onScopeChange: (scope: FilesSearchScope) => void;
  /** The scope switch shows while there's a query below a location (at the top level search always includes subfolders) */
  showScope: boolean;
  /** The results grid is on screen: the field controls it only then */
  expanded: boolean;
  /** The folder's verbs (<FilesActions placement="toolbar">), in a desktop window */
  actions?: ReactNode;
}

/**
 * The Files toolbar, in Finder order: the search scope leads, the folder's
 * verbs (Upload, New folder) trail, and the search field ends the row. The
 * field filters the folder on screen as you type and searches its subfolders
 * on Enter or with "Include subfolders".
 *
 * Below `@md` (a phone, or a very narrow window) the scope switch takes its
 * own full-width row under the field, like a scope bar under a search field,
 * so a phone can go back from "Include subfolders" (which the keyboard's
 * Search key picks) to "This folder" without retyping the query. It sits
 * under the field rather than above it so the field doesn't move while
 * you type the first letter.
 *
 * In a desktop window it sits in the window's unified toolbar, after Back
 * and the title, and carries the verbs as one capsule. In classic mode it
 * sits above the list and the verbs stay in the page header
 * (pageActionAtom).
 */
export function FilesToolbar({
  inputRef,
  query,
  onQueryChange,
  onClear,
  onFieldKeyDown,
  locationLabel,
  scope,
  onScopeChange,
  showScope,
  expanded,
  actions,
}: FilesToolbarProps) {
  const label = `Search ${locationLabel}`;
  return (
    <DesktopAppToolbar data-compact-toolbar={showScope ? undefined : ""} className="flex shrink-0 flex-wrap items-center gap-2 px-[var(--window-pad,0.75rem)] pb-3">
      {showScope && (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={scope}
          onValueChange={(value) => {
            if (value === "folder" || value === "deep") onScopeChange(value);
          }}
          aria-label="Where to search"
          data-files-scope=""
          className="order-last flex w-full shrink-0 @md:order-none @md:w-auto"
        >
          <ToggleGroupItem value="folder" className="flex-1 px-2.5 phone-touch:h-11 @md:flex-none">
            This folder
          </ToggleGroupItem>
          <ToggleGroupItem value="deep" className="flex-1 px-2.5 phone-touch:h-11 @md:flex-none">
            Include subfolders
          </ToggleGroupItem>
        </ToggleGroup>
      )}
      {actions ? (
        <div data-files-actions="" data-toolbar-secondary="" className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
        </div>
      ) : null}
      <div data-files-search="" className={cn("relative min-w-0 flex-1 @md:max-w-xs", !actions && "ml-auto")}>
        <SearchField
          ref={inputRef}
          type="search"
          role="combobox"
          aria-haspopup="grid"
          aria-expanded={expanded}
          aria-controls={expanded ? SEARCH_RESULTS_ID : undefined}
          aria-autocomplete="list"
          aria-label={label}
          placeholder={label}
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onFieldKeyDown}
          containerClassName="flex-1"
          className="h-8 pr-14 text-sm phone-touch:h-11 pointer-coarse:text-base [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search"
            onClick={onClear}
            className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring phone-touch:size-11"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden="true" />
          </button>
        ) : (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border/60 px-1 font-sans text-xs text-muted-foreground pointer-coarse:hidden"
          >
            {SHORTCUTS.filesSearch.hint}
          </kbd>
        )}
      </div>
    </DesktopAppToolbar>
  );
}

interface FilesActionsProps {
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  /**
   * "toolbar": a desktop window's unified toolbar, as one capsule of icon
   * buttons (named, with tooltips). "header": the classic page header, where
   * the labels show from `sm` up.
   */
  placement: "toolbar" | "header";
}

/**
 * The folder's verbs: Upload (Files… or Folder…, which keeps the folder's
 * structure) and New folder. The same two controls in a window's toolbar and
 * in the classic header, so both modes reach the same actions.
 */
export function FilesActions({ onUploadFiles, onUploadFolder, onNewFolder, placement }: FilesActionsProps) {
  const uploadMenu = (
    <DropdownMenuContent align="end" className="w-40">
      <DropdownMenuItem onSelect={onUploadFiles}>
        <HugeiconsIcon icon={FileUploadIcon} size={14} aria-hidden="true" />
        Files…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onUploadFolder}>
        <HugeiconsIcon icon={FolderUploadIcon} size={14} aria-hidden="true" />
        Folder…
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (placement === "toolbar") {
    // Related verbs share one capsule (Finder's grouped toolbar items)
    return (
      <ToolbarGroup aria-label="Folder actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarGroupButton icon={CloudUploadIcon} label="Upload" />
          </DropdownMenuTrigger>
          {uploadMenu}
        </DropdownMenu>
        <ToolbarGroupButton icon={FolderAddIcon} label="New folder" onClick={onNewFolder} />
      </ToolbarGroup>
    );
  }

  const buttonClass = "h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground phone-touch:h-11 phone-touch:min-w-11";
  const labelClass = "sr-only sm:not-sr-only";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" title="Upload" className={buttonClass}>
            <HugeiconsIcon icon={CloudUploadIcon} size={14} aria-hidden="true" />
            <span className={labelClass}>Upload</span>
          </Button>
        </DropdownMenuTrigger>
        {uploadMenu}
      </DropdownMenu>
      <Button type="button" variant="ghost" size="sm" title="New folder" className={buttonClass} onClick={onNewFolder}>
        <HugeiconsIcon icon={FolderAddIcon} size={14} aria-hidden="true" />
        <span className={labelClass}>New folder</span>
      </Button>
    </>
  );
}
