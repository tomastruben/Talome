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
  const visible = expanded ? releases : releases.slice(0, maxResults);
  const hasMore = releases.length > maxResults;
  const hiddenByFilter = totalFromIndexer != null && totalFromIndexer > releases.length && !showAll;

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

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!error && releases.length === 0 && !loading && (
        <p className="text-xs text-muted-foreground">No releases loaded yet.</p>
      )}

      {visible.length > 0 && (
        <div className="space-y-1">
          {visible.map((r, i) => {
            const queuePct = queueByTitle?.get(r.title.toLowerCase()) ?? null;
            return (
              <ReleaseResultCard
                key={`${String(r.raw?.guid ?? r.title)}-${i}`}
                release={r}
                isSubmitting={submittingTitle === r.title}
                isSubmitted={submittedTitles?.has(r.title) ?? false}
                queuePercent={queuePct}
                onAction={() => onGrab(r)}
              />
            );
          })}
          {hasMore && !hiddenByFilter && (
            <button
              type="button"
              className="w-full text-xs text-muted-foreground hover:text-foreground py-1 transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : `Show all ${releases.length} releases`}
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
              {expanded ? "Show less" : `Show all ${releases.length} matched`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
