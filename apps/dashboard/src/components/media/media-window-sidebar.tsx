"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Calendar01Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  Download01Icon,
  FileVideoIcon,
  Film01Icon,
  Notification01Icon,
  PlayIcon,
  PlayListAddIcon,
  Refresh04Icon,
  Search01Icon,
  Tv01Icon,
  UserIcon,
  ViewOffSlashIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { SourceList, SourceListItem, SourceListSection } from "@/components/ui/source-list";
import { useDownloads } from "@/hooks/use-downloads";
import {
  useMediaCalendar,
  useMediaLibrary,
  useMediaRequests,
  useMediaWanted,
  useMovieHealth,
  usePlexWatching,
  usePlexWatchlist,
  usePlexWatchStatus,
  useHourClock,
  wantedTotal,
  watchStatusOrNull,
} from "@/components/media/media-data";
import {
  COLLECTION_LABELS,
  SECTION_LABELS,
  TAB_LABELS,
  collectionCounts,
  genreCounts,
  isLibraryTab,
  type LibraryTab,
  type MediaCollection,
  type MediaLocation,
} from "@/components/media/media-library-view";

/** Genres listed before "Show all {n} genres". */
export const TOP_GENRES = 8;

const COLLECTION_ICONS: Record<Exclude<MediaCollection, "all">, IconSvgElement> = {
  recent: Clock01Icon,
  unwatched: ViewOffSlashIcon,
  missing: FileVideoIcon,
  ready: CheckmarkCircle01Icon,
  "needs-conversion": Refresh04Icon,
};

/** Collection rows in sidebar order. "Ready to play" appears only while it is the current view. */
const SIDEBAR_COLLECTIONS: readonly Exclude<MediaCollection, "all">[] = ["recent", "unwatched", "missing", "needs-conversion", "ready"];

const nf = new Intl.NumberFormat();

/**
 * A count when there is something to count: never while loading. SourceListItem
 * formats numbers and drops a 0.
 */
function countOrNothing(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

/** The solid amber "needs you" count, with words for screen readers. */
function NeedsYou({ value, label }: { value: number; label: string }) {
  return (
    <Badge variant="count">
      {nf.format(value)}
      <span className="sr-only"> {label}</span>
    </Badge>
  );
}

export interface MediaWindowSidebarProps {
  /** Where the app is now; exactly one location row is current. */
  location: MediaLocation;
  /** The library collections count against (the last of Movies or TV shows). */
  libraryTab: LibraryTab;
  /** Selected genres (only shown on Movies and TV shows). */
  genres: readonly string[];
  onNavigate: (location: MediaLocation) => void;
  onGenresChange: (genres: string[]) => void;
}

/**
 * The Media window's Finder-style sidebar: the library, its collections, what
 * is in flight, Plex, and genres. Rows appear only for data that is known and
 * true; a count shows only once it has loaded and is above zero.
 */
export function MediaWindowSidebar({ location, libraryTab, genres, onNavigate, onGenresChange }: MediaWindowSidebarProps) {
  const library = useMediaLibrary();
  const watchStatus = usePlexWatchStatus();
  const health = useMovieHealth(library.data?.movies);
  const calendar = useMediaCalendar();
  const wantedTv = useMediaWanted("sonarr");
  const wantedMovies = useMediaWanted("radarr");
  const requests = useMediaRequests();
  const watchlist = usePlexWatchlist();
  const watching = usePlexWatching();
  const downloads = useDownloads();
  const [showAllGenres, setShowAllGenres] = useState(false);

  const isActive = (tab: MediaLocation["tab"], collection: MediaCollection = "all", section: MediaLocation["section"] = "all") =>
    location.tab === tab
    && (!isLibraryTab(tab) || location.collection === collection)
    && (tab !== "activity" || location.section === section);

  const go = (tab: MediaLocation["tab"], collection: MediaCollection = "all", section: MediaLocation["section"] = "all") =>
    onNavigate({ tab, collection, section });

  // ── Library and collections ────────────────────────────────────────────────
  const libraryData = library.data;
  // Collections follow the library on screen, or the last one shown.
  const collectionTab: LibraryTab = isLibraryTab(location.tab) ? location.tab : libraryTab;
  const countsReady = !!libraryData && !library.error;
  const libraryItems = libraryData ? (collectionTab === "movies" ? libraryData.movies : libraryData.tv) : null;
  const watchStatusMap = watchStatusOrNull(watchStatus.data);
  const healthOf = health.healthOf;
  const now = useHourClock();
  const counts = useMemo(
    () => (libraryItems ? collectionCounts(libraryItems, collectionTab, { now, watchStatus: watchStatusMap, health: healthOf }) : null),
    [libraryItems, collectionTab, now, watchStatusMap, healthOf],
  );

  const collectionRows = SIDEBAR_COLLECTIONS.flatMap((collection) => {
    const active = isActive(collectionTab, collection);
    const count = countsReady ? counts?.[collection] : undefined;
    const shown = active || (collection !== "ready" && count != null && count > 0);
    if (!shown) return [];
    return [(
      <SourceListItem
        key={collection}
        icon={COLLECTION_ICONS[collection]}
        label={COLLECTION_LABELS[collection]}
        active={active}
        trailing={countOrNothing(count)}
        onSelect={() => go(collectionTab, collection)}
      />
    )];
  });

  // ── Activity ───────────────────────────────────────────────────────────────
  let downloadsTrailing: ReactNode = null;
  if (downloads.data) {
    const { activity } = downloads;
    if (activity.counts.attention > 0) {
      downloadsTrailing = (
        <NeedsYou value={activity.counts.attention} label={activity.counts.attention === 1 ? "needs attention" : "need attention"} />
      );
    } else if (activity.activeCount > 0) {
      downloadsTrailing = (
        <span className="flex shrink-0 items-center gap-1.5">
          <StatusDot state="working" size="sm" label="Downloading" hideLabel />
          {activity.pendingCount > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">{nf.format(activity.pendingCount)}</span>
          )}
        </span>
      );
    } else {
      downloadsTrailing = countOrNothing(activity.pendingCount);
    }
  }

  const calendarCount = calendar.data ? calendar.data.episodes.length + calendar.data.movies.length : null;

  const wantedCount = wantedTotal(wantedTv.data, wantedMovies.data);
  const wantedUnavailable = (d: typeof wantedTv) => !!d.error || d.data?.available === false;
  const wantedHidden = wantedUnavailable(wantedTv) && wantedUnavailable(wantedMovies) && !wantedCount;
  const wantedActive = isActive("activity", "all", "wanted");

  const requestsConfigured = requests.data?.configured === true;
  const pendingRequests = requests.data?.results.filter((r) => r.status === 1).length ?? 0;
  const requestsActive = isActive("activity", "all", "requests");

  const plexConfigured = watching.data?.configured === true || watchlist.data?.configured === true;
  const continueActive = isActive("activity", "all", "continue");
  const watchlistActive = isActive("activity", "all", "watchlist");
  const continueCount = watching.data?.configured ? (watching.data.continueWatching?.length ?? 0) : null;
  const watchlistCount = watchlist.data?.configured ? watchlist.data.items.length : null;

  // ── Genres ─────────────────────────────────────────────────────────────────
  const genreTab = isLibraryTab(location.tab) ? location.tab : null;
  const genreItems = libraryData && genreTab ? (genreTab === "movies" ? libraryData.movies : libraryData.tv) : null;
  const allGenres = useMemo(() => (genreItems ? genreCounts(genreItems) : []), [genreItems]);
  const genreRows = useMemo(() => {
    const listed = showAllGenres ? allGenres : allGenres.slice(0, TOP_GENRES);
    const rows = listed.map((g) => ({ genre: g.genre, count: g.count as number | null }));
    // A selected genre stays visible (to unselect it) even outside the top list.
    for (const genre of genres) {
      if (!rows.some((row) => row.genre === genre)) {
        rows.push({ genre, count: allGenres.find((g) => g.genre === genre)?.count ?? null });
      }
    }
    return rows;
  }, [allGenres, genres, showAllGenres]);

  const toggleGenre = (genre: string) => {
    onGenresChange(genres.includes(genre) ? genres.filter((g) => g !== genre) : [...genres, genre]);
  };

  return (
    <SourceList label="Media">
      <SourceListSection title="Library">
        <SourceListItem
          icon={Film01Icon}
          label={TAB_LABELS.movies}
          active={isActive("movies")}
          trailing={countOrNothing(libraryData?.movies.length)}
          onSelect={() => go("movies")}
        />
        <SourceListItem
          icon={Tv01Icon}
          label={TAB_LABELS.tv}
          active={isActive("tv")}
          trailing={countOrNothing(libraryData?.tv.length)}
          onSelect={() => go("tv")}
        />
      </SourceListSection>

      {collectionRows.length > 0 && (
        <SourceListSection title="Collections">{collectionRows}</SourceListSection>
      )}

      <SourceListSection title="Activity">
        {isActive("activity") && (
          <SourceListItem icon={Notification01Icon} label="All activity" active onSelect={() => go("activity")} />
        )}
        <SourceListItem
          icon={Download01Icon}
          label={TAB_LABELS.downloads}
          active={isActive("downloads")}
          trailing={downloadsTrailing}
          onSelect={() => go("downloads")}
        />
        <SourceListItem
          icon={Calendar01Icon}
          label={TAB_LABELS.calendar}
          active={isActive("calendar")}
          trailing={countOrNothing(calendarCount)}
          onSelect={() => go("calendar")}
        />
        {(!wantedHidden || wantedActive) && (
          <SourceListItem
            icon={Search01Icon}
            label={SECTION_LABELS.wanted}
            active={wantedActive}
            trailing={countOrNothing(wantedCount)}
            onSelect={() => go("activity", "all", "wanted")}
          />
        )}
        {(requestsConfigured || requestsActive) && (
          <SourceListItem
            icon={UserIcon}
            label={SECTION_LABELS.requests}
            active={requestsActive}
            trailing={pendingRequests > 0 ? <NeedsYou value={pendingRequests} label="awaiting approval" /> : null}
            onSelect={() => go("activity", "all", "requests")}
          />
        )}
      </SourceListSection>

      {(plexConfigured || continueActive || watchlistActive) && (
        <SourceListSection title="Watching">
          <SourceListItem
            icon={PlayIcon}
            label={SECTION_LABELS.continue}
            active={continueActive}
            trailing={countOrNothing(continueCount)}
            onSelect={() => go("activity", "all", "continue")}
          />
          <SourceListItem
            icon={PlayListAddIcon}
            label={SECTION_LABELS.watchlist}
            active={watchlistActive}
            trailing={countOrNothing(watchlistCount)}
            onSelect={() => go("activity", "all", "watchlist")}
          />
        </SourceListSection>
      )}

      {genreTab && (allGenres.length > 0 || genres.length > 0) && (
        <SourceListSection title="Genres">
          <SourceListItem
            label="All genres"
            pressed={genres.length === 0}
            onSelect={() => onGenresChange([])}
          />
          {genreRows.map((row) => (
            <SourceListItem
              key={row.genre}
              label={row.genre}
              pressed={genres.includes(row.genre)}
              trailing={countOrNothing(row.count)}
              onSelect={() => toggleGenre(row.genre)}
            />
          ))}
          {allGenres.length > TOP_GENRES && (
            <SourceListItem
              label={showAllGenres ? "Show fewer" : `Show all ${nf.format(allGenres.length)} genres`}
              aria-expanded={showAllGenres}
              onSelect={() => setShowAllGenres((v) => !v)}
            />
          )}
        </SourceListSection>
      )}
    </SourceList>
  );
}
