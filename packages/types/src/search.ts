/** Unified search result types — used by GET /api/search and the command palette. */

export interface SearchResultBase {
  id: string;
  name: string;
  /** Relevance score 0–1, used for cross-category ranking. */
  score: number;
}

export interface MediaSearchResult extends SearchResultBase {
  type: "movie" | "tv";
  year: number;
  overview: string;
  /** Poster proxy URL (e.g. /api/media/poster?service=radarr&path=...) or remote TMDB URL. */
  poster: string | null;
  /** Sonarr series ID or Radarr movie ID — for navigation (0 if not in library). */
  serviceId: number;
  /** True when the item exists in the local Sonarr/Radarr library. */
  inLibrary: boolean;
  /** TMDB ID (movies always, TV sometimes). */
  tmdbId: number | null;
  /** TVDB ID (TV always, movies sometimes). */
  tvdbId: number | null;
  /** Rating (0–10 scale, from TMDB or Sonarr/Radarr). */
  rating: number | null;
}

export interface AppSearchResult extends SearchResultBase {
  storeId: string;
  category: string;
  icon: string | null;
  iconUrl: string | null;
  installed: boolean;
}

export interface ContainerSearchResult extends SearchResultBase {
  image: string;
  status: "running" | "stopped" | "restarting" | "paused" | "exited" | "created";
}

export interface AudiobookSearchResult extends SearchResultBase {
  author: string;
  cover: string | null;
  duration: number | null;
}

export interface AutomationSearchResult extends SearchResultBase {
  enabled: boolean;
  lastRunAt: string | null;
}

export type SearchResult =
  | ({ kind: "media" } & MediaSearchResult)
  | ({ kind: "app" } & AppSearchResult)
  | ({ kind: "container" } & ContainerSearchResult)
  | ({ kind: "audiobook" } & AudiobookSearchResult)
  | ({ kind: "automation" } & AutomationSearchResult);

export interface UnifiedSearchResponse {
  query: string;
  results: SearchResult[];
  /** Per-source latency in ms — for debugging, not displayed. */
  timing: Record<string, number>;
}
