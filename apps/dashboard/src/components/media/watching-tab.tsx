"use client";

import Image from "next/image";
import { useState } from "react";
import {
  HugeiconsIcon,
  Film01Icon,
  Tv01Icon,
  PlayListAddIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { CORE_URL, resolvePosterUrl } from "@/lib/constants";

export interface PlexWatchlistItem {
  ratingKey: string;
  title: string;
  type: "movie" | "tv";
  year?: number;
  poster?: string;
  guid?: string;
  tmdbId?: number;
}

export function WatchlistSection({
  items,
  libraryTmdbIds,
}: {
  items: PlexWatchlistItem[];
  libraryTmdbIds: Set<number>;
}) {
  const [requesting, setRequesting] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  async function addToLibrary(item: PlexWatchlistItem) {
    setRequesting(item.ratingKey);
    try {
      const res = await fetch(`${CORE_URL}/api/media/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          title: item.title,
          type: item.type,
          tmdbId: item.tmdbId,
        }),
      });
      if (res.ok) {
        setRequested((prev) => new Set(prev).add(item.ratingKey));
      }
    } catch { /* silent */ }
    setRequesting(null);
  }

  // Show items not already in library first
  const notInLibrary = items.filter((i) => i.tmdbId && !libraryTmdbIds.has(i.tmdbId));
  const inLibrary = items.filter((i) => !i.tmdbId || libraryTmdbIds.has(i.tmdbId));

  if (items.length === 0) {
    return (
      <EmptyState
        icon={PlayListAddIcon}
        title="Watchlist empty"
        description="Add movies and shows to your Plex watchlist and they'll appear here."
      />
    );
  }

  return (
    <div className="grid gap-2">
      {[...notInLibrary, ...inLibrary].map((item) => {
        const inLib = item.tmdbId ? libraryTmdbIds.has(item.tmdbId) : false;
        const isRequested = requested.has(item.ratingKey);
        const posterUrl = resolvePosterUrl(item.poster, 120) ?? null;

        return (
          <div
            key={item.ratingKey}
            className="relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch h-[72px]"
          >
            {/* Poster strip */}
            <div className="w-12 shrink-0 relative bg-muted/40 border-r border-border/40">
              {posterUrl ? (
                <Image
                  src={posterUrl}
                  alt={`${item.title} poster`}
                  className="object-cover"
                  fill
                  decoding="async"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <HugeiconsIcon
                    icon={item.type === "tv" ? Tv01Icon : Film01Icon}
                    size={14}
                    className="text-dim-foreground"
                  />
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 flex items-center gap-3 px-3.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate leading-snug">{item.title}</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {[item.type === "tv" ? "TV" : "Movie", item.year].filter(Boolean).join(" · ")}
                </p>
              </div>

              <div className="shrink-0">
                {inLib ? (
                  <span className="text-xs text-status-healthy">In library</span>
                ) : isRequested ? (
                  <span className="text-xs text-status-info">Added</span>
                ) : item.tmdbId ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs px-2.5"
                    disabled={requesting === item.ratingKey}
                    onClick={() => addToLibrary(item)}
                  >
                    {requesting === item.ratingKey ? (
                      <Spinner className="h-3 w-3" />
                    ) : (
                      "Add"
                    )}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
