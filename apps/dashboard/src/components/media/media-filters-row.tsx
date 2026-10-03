"use client";

import { Button } from "@/components/ui/button";
import { WINDOW_SIDEBAR_REPLACES } from "@/components/ui/source-list";
import { cn } from "@/lib/utils";

/**
 * A genre pill. 24px with a mouse; on touch it grows to a 44px target itself,
 * because the rail scrolls (overflow-x clips overflow-y, so an enlarged hit
 * area outside the pill would be cut off).
 */
export function mediaFilterPill(active: boolean): string {
  return cn(
    "h-6 shrink-0 rounded-full border px-2 text-xs transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring phone-touch:h-11 phone-touch:px-3",
    active
      ? "border-foreground/30 bg-foreground/10 text-foreground"
      : "border-border text-muted-foreground hover:text-foreground",
  );
}

/**
 * The genre rail and the active-filter line above the library grid. In a wide
 * window the sidebar lists the genres, so the rail is for classic mode
 * (phones included, where it is the only genre navigation) and narrow windows.
 */
export function MediaFiltersRow({
  genres,
  selectedGenres,
  minRating,
  onToggleGenre,
  onClearFilters,
}: {
  genres: readonly string[];
  selectedGenres: readonly string[];
  minRating: number | null;
  onToggleGenre: (genre: string) => void;
  onClearFilters: () => void;
}) {
  const hasActiveFilters = selectedGenres.length > 0 || minRating !== null;

  if (genres.length === 0 && !hasActiveFilters) return null;

  return (
    <div className={cn("grid gap-2", !hasActiveFilters && WINDOW_SIDEBAR_REPLACES)}>
      {genres.length > 0 && (
        <div className={cn("flex min-w-0 items-center gap-1.5", WINDOW_SIDEBAR_REPLACES)}>
          <button
            type="button"
            aria-pressed={!hasActiveFilters}
            onClick={onClearFilters}
            className={mediaFilterPill(!hasActiveFilters)}
          >
            All
          </button>
          <div className="relative min-w-0 max-w-full flex-1">
            {/* Only the trailing edge fades (a mask, so it reads on window
                glass too): the first genre stays whole before any scroll */}
            <div
              data-media-genre-rail
              className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]"
            >
              {genres.map((genre) => {
                const active = selectedGenres.includes(genre);
                return (
                  <button
                    key={genre}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onToggleGenre(genre)}
                    className={mediaFilterPill(active)}
                  >
                    {genre}
                  </button>
                );
              })}
              {/* Room to scroll the last pill clear of the fade */}
              <span aria-hidden="true" className="w-4 shrink-0" />
            </div>
          </div>
        </div>
      )}

      {hasActiveFilters && (
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {selectedGenres.length > 0 ? selectedGenres.join(" · ") : "All genres"}
            {minRating !== null ? ` · Rated ${minRating}+` : ""}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Clear filters"
            className="h-6 shrink-0 px-2 text-xs phone-touch:h-11 phone-touch:px-3"
            onClick={onClearFilters}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
