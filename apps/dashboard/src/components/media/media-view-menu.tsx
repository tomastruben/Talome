"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon, SlidersHorizontalIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  MEDIA_SORT_KEYS,
  RATING_OPTIONS,
  SORT_LABELS,
  collectionLabel,
  type LibraryTab,
  type MediaCollection,
  type MediaSortKey,
} from "@/components/media/media-library-view";

/**
 * The library toolbar keeps one row. Where the content column is wide enough
 * the view controls sit inline as selects; anywhere narrower they fold into one
 * Sort and filter menu. Both are container queries: in a window the column
 * beside the sidebar (from 48rem, where only the heading shares the row), in
 * classic mode the page (from 80rem, where the labelled tab strip with its
 * counts, the search and four selects share the row; the toolbar-fit model in
 * media-window-layout.test.tsx checks it with every count and badge showing).
 */
export const MEDIA_VIEW_INLINE = "hidden @3xl/content:flex @7xl:flex";
export const MEDIA_VIEW_MENU = "@3xl/content:hidden @7xl:hidden";

export interface MediaViewMenuProps {
  libraryTab: LibraryTab;
  /** Collections to offer, or null where the window sidebar lists them. */
  collections: readonly MediaCollection[] | null;
  collection: MediaCollection;
  sort: MediaSortKey;
  minRating: number | null;
  onCollectionChange: (collection: MediaCollection) => void;
  onSortChange: (sort: MediaSortKey) => void;
  onMinRatingChange: (minRating: number | null) => void;
  className?: string;
}

/**
 * Sort, minimum rating and (outside a window with a sidebar) the collection,
 * folded into one toolbar button. The button reads as pressed while a
 * filter narrows the view, so a hidden filter is never a surprise.
 */
export function MediaViewMenu({
  libraryTab,
  collections,
  collection,
  sort,
  minRating,
  onCollectionChange,
  onSortChange,
  onMinRatingChange,
  className,
}: MediaViewMenuProps) {
  const showCollections = collections !== null && collections.length > 1;
  const filtered = minRating !== null || (showCollections && collection !== "all");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={filtered ? "secondary" : "outline"}
          size="icon-sm"
          className={cn("pointer-coarse:size-11", className)}
          aria-label={filtered ? "Sort and filter, filtered" : "Sort and filter"}
          title="Sort and filter"
        >
          <HugeiconsIcon icon={SlidersHorizontalIcon} size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {showCollections && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Show</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={collection}
                onValueChange={(value) => onCollectionChange(value as MediaCollection)}
              >
                {collections.map((c) => (
                  <DropdownMenuRadioItem key={c} value={c}>
                    {collectionLabel(libraryTab, c)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as MediaSortKey)}>
            {MEDIA_SORT_KEYS.map((key) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {SORT_LABELS[key]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Rating</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={minRating === null ? "any" : String(minRating)}
            onValueChange={(value) => onMinRatingChange(value === "any" ? null : Number(value))}
          >
            <DropdownMenuRadioItem value="any">Any rating</DropdownMenuRadioItem>
            {RATING_OPTIONS.map((rating) => (
              <DropdownMenuRadioItem key={rating} value={String(rating)} aria-label={`Rated ${rating} or higher`}>
                Rated {rating}+
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
