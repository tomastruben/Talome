export interface DownloadQueueItem {
  id: number;
  title: string;
  status: string;
  size: number;
  sizeleft: number;
  type: "tv" | "movie";
  movieId?: number | null;
  seriesId?: number | null;
  estimatedCompletionTime: string | null;
  // Enriched fields (added by backend correlation with qBittorrent)
  downloadId?: string | null;
  progress?: number;
  dlspeed?: number;
  eta?: number | null;
  /** qBittorrent state correlated by downloadId (for example stalledDL). */
  torrentState?: string | null;
  connectedSeeds?: number;
  connectedLeechers?: number;
  swarmSeeds?: number;
  swarmLeechers?: number;
  /** qBittorrent availability, where 1 means one complete copy is available. */
  availability?: number | null;
  /** Unix timestamp, in seconds, when qBittorrent added the torrent. */
  addedOn?: number | null;
  poster?: string | null;
  errorMessage?: string | null;
  statusMessages?: string[];
}

export interface DownloadTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  state: string;
  eta: number;
  connectedSeeds?: number;
  connectedLeechers?: number;
  swarmSeeds?: number;
  swarmLeechers?: number;
  availability?: number | null;
  addedOn?: number | null;
  poster?: string | null;
}

export interface DownloadsData {
  queue: DownloadQueueItem[];
  torrents: DownloadTorrent[];
}
