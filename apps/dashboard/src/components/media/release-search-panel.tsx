"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ReleaseResultCard } from "@/components/media/release-result-card";

interface ReleaseData {
  title: string;
  quality?: string | null;
  size?: number | null;
  ageHours?: number | null;
  indexer?: string | null;
  seeders?: number | null;
  leechers?: number | null;
  rejected?: boolean;
  downloadAllowed?: boolean;
  rejections?: string[];
  containerFormat?: "mp4" | "mkv" | "avi" | null;
  raw?: Record<string, unknown>;
}

function isOutsideProfile(release: ReleaseData) {
  return release.rejected === true
    || release.downloadAllowed === false
    || (release.rejections?.length ?? 0) > 0;
}

export function ReleaseSearchPanel({
  loading,
  error,
  releases,
  totalFromIndexer,
  submittingTitle,
  submittedTitles,
  queueByTitle,
  onSearch,
  onGrab,
  onClose,
  maxResults = 8,
  searchLabel,
  onClearFilter,
  preferMp4,
  onToggleMp4,
  showAll,
  onShowAll,
}: {
  loading: boolean;
  error: string | null;
  releases: ReleaseData[];
  totalFromIndexer?: number;
  submittingTitle: string | null;
  submittedTitles?: Set<string>;
  queueByTitle?: Map<string, number>;
  onSearch?: () => void;
  onGrab: (release: ReleaseData) => void;
  onClose?: () => void;
  maxResults?: number;
  searchLabel?: string;
  onClearFilter?: () => void;
  preferMp4?: boolean;
  onToggleMp4?: (value: boolean) => void;
  showAll?: boolean;
  onShowAll?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const matching = releases.filter((release) => !isOutsideProfile(release));
  const alternatives = releases.filter(isOutsideProfile);
  const noMatchingReleases = releases.length > 0 && matching.length === 0;
  const primaryReleases = noMatchingReleases ? alternatives : matching;
  const visiblePrimary = expanded ? primaryReleases : primaryReleases.slice(0, maxResults);
  const visibleAlternatives = showAlternatives ? alternatives : [];
  const hasMore = primaryReleases.length > maxResults;
  const hiddenByFilter = totalFromIndexer != null && totalFromIndexer > releases.length && !showAll;
  const renderRelease = (release: ReleaseData, index: number, group: "match" | "alternative") => {
    const queuePct = queueByTitle?.get(release.title.toLowerCase()) ?? null;
    return (
      <ReleaseResultCard
        key={`${group}-${String(release.raw?.guid ?? release.title)}-${index}`}
        release={release}
        isSubmitting={submittingTitle === release.title}
        isSubmitted={submittedTitles?.has(release.title) ?? false}
        queuePercent={queuePct}
        onAction={() => onGrab(release)}
      />
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          Releases
          {searchLabel && (
            <>
              <span className="text-dim-foreground">{`\u00b7 ${searchLabel}`}</span>
              {onClearFilter && (
                <button
                  type="button"
                  onClick={onClearFilter}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Clear filter"
                >
                  ×
                </button>
              )}
            </>
          )}
        </p>
        <div className="flex items-center gap-1">
          {onToggleMp4 && (
            <Button
              type="button"
              size="sm"
              variant={preferMp4 ? "default" : "ghost"}
              className={`h-6 text-xs px-1.5 ${preferMp4 ? "bg-status-healthy/15 text-status-healthy hover:bg-status-healthy/25" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => onToggleMp4(!preferMp4)}
            >
              MP4
            </Button>
          )}
          {onSearch && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 text-xs text-muted-foreground hover:text-foreground px-2"
              onClick={onSearch}
              disabled={loading}
            >
              {loading ? "Searching..." : releases.length > 0 ? "Refresh" : "Search"}
            </Button>
          )}
          {onClose && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground px-1"
              onClick={onClose}
            >
              Close
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-primary/70 animate-pulse" />
          <Shimmer as="p" className="text-xs">
            Searching indexers...
          </Shimmer>
        </div>
      )}

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-destructive">Release search failed</p>
            <p className="mt-0.5 text-xs leading-relaxed text-destructive/80">{error}</p>
          </div>
          {onSearch && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={onSearch}
              disabled={loading}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {!error && releases.length === 0 && !loading && (
        <div className="rounded-lg border border-dashed border-border/50 px-3 py-4 text-center">
          <p className="text-xs font-medium">No matching releases found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Search again, change the quality preference, or include every result returned by the indexers.
          </p>
          {hiddenByFilter && onShowAll && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3 h-7 text-xs"
              onClick={onShowAll}
            >
              Show {totalFromIndexer} indexer releases
            </Button>
          )}
        </div>
      )}

      {!error && noMatchingReleases && !loading && (
        <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 px-3 py-2.5">
          <p className="text-xs font-medium text-status-warning">No releases match the current profile</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Showing the best available alternatives. Each result explains which requirement it misses, and can still be downloaded manually.
          </p>
        </div>
      )}

      {(visiblePrimary.length > 0 || visibleAlternatives.length > 0) && (
        <div className="space-y-1">
          {!noMatchingReleases && matching.length > 0 && (
            <p className="px-0.5 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-dim-foreground">
              Matches profile · {matching.length}
            </p>
          )}
          {visiblePrimary.map((release, index) => renderRelease(release, index, noMatchingReleases ? "alternative" : "match"))}
          {hasMore && !hiddenByFilter && (
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground py-1 transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : `Show all ${primaryReleases.length} releases`}
            </button>
          )}
          {/* When the title filter hid results, offer to show everything */}
          {hiddenByFilter && onShowAll && (
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground py-2 transition-colors"
              onClick={onShowAll}
            >
              {`Showing ${releases.length} of ${totalFromIndexer}\u2002·\u2002Show all`}
            </button>
          )}
          {hasMore && hiddenByFilter && (
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground py-1 transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : `Show all ${primaryReleases.length} matched`}
            </button>
          )}
          {!noMatchingReleases && alternatives.length > 0 && (
            <button
              type="button"
              className="mt-1 w-full rounded-md border border-status-warning/15 bg-status-warning/[0.025] py-2 text-xs text-status-warning/80 transition-colors hover:border-status-warning/30 hover:text-status-warning"
              onClick={() => setShowAlternatives((current) => !current)}
            >
              {showAlternatives
                ? "Hide releases outside profile"
                : `Show ${alternatives.length} release${alternatives.length === 1 ? "" : "s"} outside profile`}
            </button>
          )}
          {!noMatchingReleases && visibleAlternatives.length > 0 && (
            <div className="space-y-1 pt-2">
              <p className="px-0.5 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-status-warning/70">
                Outside profile · {alternatives.length}
              </p>
              {visibleAlternatives.map((release, index) => renderRelease(release, index, "alternative"))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
