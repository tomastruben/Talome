"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { CORE_URL } from "@/lib/constants";
import { useDownloads } from "@/hooks/use-downloads";
import { type QualityTier, QUALITY_TIERS, matchProfile } from "@talome/types";
import type { DownloadQueueItem } from "@talome/types";

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchTarget =
  | { scope: "series" }
  | { scope: "season"; seasonNumber: number }
  | { scope: "episode"; seasonNumber: number; episodeNumber: number; episodeId: number };

export interface ReleaseCandidate {
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

interface MediaRef {
  id: number;
  title: string;
  type: "movie" | "tv";
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useMediaManagement(item: MediaRef | null) {
  // Release search state
  const [releases, setReleases] = useState<ReleaseCandidate[]>([]);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [grabbingTitle, setGrabbingTitle] = useState<string | null>(null);
  const [grabbedTitles, setGrabbedTitles] = useState<Set<string>>(new Set());
  const [totalFromIndexer, setTotalFromIndexer] = useState<number | undefined>(undefined);

  // Quality profile state
  const [qualityProfiles, setQualityProfiles] = useState<Array<{ id: number; name: string }>>([]);
  const [qualityProfileId, setQualityProfileId] = useState<string>("");
  const [applyState, setApplyState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [applyError, setApplyError] = useState<string | null>(null);

  // Search targeting for TV
  const [searchTarget, setSearchTarget] = useState<SearchTarget>({ scope: "series" });

  // Quality tier (mirrors the add-to-library pattern)
  const [qualityTier, setQualityTier] = useState<QualityTier>("standard");
  const isManualProfile = useMemo(() => {
    if (!qualityProfileId || qualityProfiles.length === 0) return false;
    const resolved = matchProfile(qualityProfiles, qualityTier);
    return String(resolved.profileId) !== qualityProfileId;
  }, [qualityProfileId, qualityProfiles, qualityTier]);

  // MP4 preference
  const [preferMp4, setPreferMp4] = useState(false);

  // Show all releases (unfiltered by title matching)
  const [showAllReleases, setShowAllReleases] = useState(false);

  // Poll downloads while item is active
  const { queue } = useDownloads(item ? 3000 : 0);

  // Active downloads for this item
  const activeDownloads = useMemo<DownloadQueueItem[]>(() => {
    if (!item) return [];
    return queue.filter((q) => {
      if (item.type === "movie" && q.movieId === item.id) return true;
      if (item.type === "tv" && q.seriesId === item.id) return true;
      if (q.title && item.title) {
        const qLower = q.title.toLowerCase();
        const itemLower = item.title.toLowerCase();
        if (qLower.includes(itemLower) || itemLower.includes(qLower)) return true;
      }
      return false;
    });
  }, [item, queue]);

  // Map queue titles → download percent for matching releases to active downloads
  const queueByTitle = useMemo(() => {
    const map = new Map<string, number>();
    for (const dl of activeDownloads) {
      if (dl.title) map.set(dl.title.toLowerCase(), Math.round((dl.progress ?? 0) * 100));
    }
    return map;
  }, [activeDownloads]);

  // Reset per-item state
  useEffect(() => {
    setReleases([]);
    setReleaseError(null);
    setReleaseLoading(false);
    setGrabbingTitle(null);
    setGrabbedTitles(new Set());
    setSearchTarget({ scope: "series" });
  }, [item?.id, item?.type]);

  // Fetch quality profiles
  useEffect(() => {
    if (!item) return;
    const app = item.type === "tv" ? "sonarr" : "radarr";
    setQualityProfiles([]);
    setQualityProfileId("");
    setApplyState("idle");
    setApplyError(null);
    fetch(`${CORE_URL}/api/media/quality-profiles?app=${app}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const profiles = (data.qualityProfiles ?? []) as Array<{ id: number; name: string }>;
        setQualityProfiles(profiles);
        if (profiles.length > 0) setQualityProfileId(String(profiles[0].id));
      })
      .catch(() => {
        setQualityProfiles([]);
        setApplyError("Unable to load quality profiles.");
      });
  }, [item?.id, item?.type]);

  // Human-readable search label for TV scoping
  const searchLabel = useMemo(() => {
    if (!item || item.type !== "tv") return undefined;
    if (searchTarget.scope === "episode") {
      return `S${String(searchTarget.seasonNumber).padStart(2, "0")}E${String(searchTarget.episodeNumber).padStart(2, "0")}`;
    }
    if (searchTarget.scope === "season") return `Season ${searchTarget.seasonNumber}`;
    return undefined;
  }, [item, searchTarget]);

  const searchReleases = useCallback(async () => {
    if (!item) return;
    setReleaseLoading(true);
    setReleaseError(null);
    try {
      const app = item.type === "tv" ? "sonarr" : "radarr";
      const params = new URLSearchParams({ app });
      params.set("targetTitle", item.title);
      params.set("qualityTier", qualityTier);
      if (preferMp4) params.set("preferMp4", "true");
      if (showAllReleases) params.set("showAll", "true");
      if (item.type === "tv") {
        params.set("seriesId", String(item.id));
        if (searchTarget.scope === "season") {
          params.set("seasonNumber", String(searchTarget.seasonNumber));
        } else if (searchTarget.scope === "episode") {
          params.set("episodeId", String(searchTarget.episodeId));
        }
      } else {
        params.set("movieId", String(item.id));
      }
      const res = await fetch(`${CORE_URL}/api/media/releases?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setReleases(data.releases ?? []);
      setTotalFromIndexer(data.filterInfo?.totalFromIndexer ?? undefined);
    } catch (err: unknown) {
      setReleaseError(err instanceof Error ? err.message : "Failed to load releases");
    } finally {
      setReleaseLoading(false);
    }
  }, [item, searchTarget, preferMp4, qualityTier, showAllReleases]);

  // Re-search when quality tier, MP4 pref, or showAll changes (if releases already loaded)
  const hasSearched = useRef(false);
  useEffect(() => {
    if (releases.length > 0 || hasSearched.current) {
      hasSearched.current = true;
      searchReleases();
    }
  // Only re-trigger on filter changes, not on releases/searchReleases itself
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualityTier, preferMp4, showAllReleases]);

  const selectSearchTarget = useCallback((target: SearchTarget) => {
    setSearchTarget(target);
    setReleases([]);
    setReleaseError(null);
  }, []);

  const grabRelease = useCallback(async (release: ReleaseCandidate) => {
    if (!release.raw || !item) return;
    const app = item.type === "tv" ? "sonarr" : "radarr";
    setGrabbingTitle(release.title);
    try {
      const res = await fetch(`${CORE_URL}/api/media/releases/grab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app,
          release: release.raw,
          ...(item.type === "movie" ? { movieId: item.id } : { seriesId: item.id }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setGrabbedTitles((prev) => new Set(prev).add(release.title));
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "Failed to grab release");
    } finally {
      setGrabbingTitle(null);
    }
  }, [item]);

  const removeFromQueue = useCallback(async (queueId: number) => {
    if (!item) return;
    const app = item.type === "tv" ? "sonarr" : "radarr";
    try {
      const res = await fetch(`${CORE_URL}/api/media/queue/${queueId}?app=${app}&removeFromClient=true`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "Failed to remove");
    }
  }, [item]);

  const applyQualityProfile = useCallback((next: string) => {
    if (!item) return;
    setQualityProfileId(next);
    if (next) {
      setApplyState("loading");
      setApplyError(null);
      const app = item.type === "tv" ? "sonarr" : "radarr";
      fetch(`${CORE_URL}/api/media/quality-profile/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, qualityProfileId: Number(next), mediaId: item.id }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          setApplyState("done");
          setTimeout(() => setApplyState("idle"), 1200);
        })
        .catch((err: unknown) => {
          setApplyError(err instanceof Error ? err.message : "Failed to apply");
          setApplyState("error");
        });
    }
  }, [item]);

  return {
    // Release search
    releases,
    releaseLoading,
    releaseError,
    totalFromIndexer,
    grabbingTitle,
    grabbedTitles,
    searchReleases,
    grabRelease,

    // Quality profiles
    qualityProfiles,
    qualityProfileId,
    applyState,
    applyError,
    applyQualityProfile,

    // Quality tier
    qualityTier,
    setQualityTier,
    isManualProfile,

    // Search targeting (TV)
    searchTarget,
    searchLabel,
    selectSearchTarget,

    // Downloads
    activeDownloads,
    queueByTitle,
    removeFromQueue,

    // MP4 preference
    preferMp4,
    setPreferMp4,

    // Show all releases (unfiltered)
    showAllReleases,
    showAll: () => setShowAllReleases(true),
  };
}
