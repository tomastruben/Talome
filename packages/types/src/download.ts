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
  poster?: string | null;
}

export interface DownloadsData {
  queue: DownloadQueueItem[];
  torrents: DownloadTorrent[];
}
