"use client";

import type { KeyboardEvent, RefObject } from "react";
import { HugeiconsIcon, Cancel01Icon } from "@/components/icons";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { SEARCH_RESULTS_ID } from "@/components/files/file-search-results";
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SHORTCUTS } from "@/lib/keymap";

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
}

/**
 * The Files toolbar: one search field that filters the folder on screen as you
 * type, and searches its subfolders on Enter or with "Include subfolders". In a
 * desktop window it sits in the window's toolbar slot; in classic mode it sits
 * above the list. Upload and New stay in the header (classic) or the title bar.
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
}: FilesToolbarProps) {
  const label = `Search ${locationLabel}`;
  return (
    <DesktopAppToolbar className="flex shrink-0 items-center gap-2 px-[var(--window-pad,0.75rem)] pb-3">
      <div className="relative min-w-0 flex-1 @md:max-w-sm">
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
          className="h-8 pr-14 text-sm pointer-coarse:text-base [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search"
            onClick={onClear}
            className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:size-11"
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
          className="hidden shrink-0 @md:flex"
        >
          <ToggleGroupItem value="folder" className="px-2.5">
            This folder
          </ToggleGroupItem>
          <ToggleGroupItem value="deep" className="px-2.5">
            Include subfolders
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    </DesktopAppToolbar>
  );
}
