/** Transcoding configuration — persisted in settings DB. */
export interface TranscodingConfig {
  /** Directory for HLS temp segments. Defaults to /tmp/talome/hls. */
  hlsTempDirectory: string;
  /** Directory for transmux temp files. Defaults to /tmp/talome-transmux. */
  transmuxTempDirectory: string;
  /** Skip transcoding when source codec is already browser-compatible. */
  enableSmartDetection: boolean;
  /** Preferred output codecs in order. Empty = auto-detect. */
  preferredCodecs: string[];
  /** Cache transcoded files for replay (skip re-transcode on same content). */
  enableTranscodeCache: boolean;
  /** Max concurrent HLS jobs. */
  maxConcurrentJobs: number;
  /** Write temp files next to source video instead of system temp dir. */
  useSourceFolderTemp: boolean;
}

/** Fullscreen media player settings — stored in localStorage. */
export interface FullscreenMediaSettings {
  /** Text scale multiplier for fullscreen (1.0 = default, 2.0 = double). */
  textScale: number;
  /** Auto-hide controls delay in ms (default 3000). */
  controlsHideDelay: number;
  /** Seek step in seconds for arrow key navigation (default 10). */
  seekStep: number;
  /** Large seek step in seconds for shift+arrow (default 30). */
  largeSeekStep: number;
  /** Volume step for +/- keys (default 0.1). */
  volumeStep: number;
  /** Show media info overlay on play start. */
  showInfoOnStart: boolean;
}

/** Library optimization configuration — persisted in settings DB. */
export interface OptimizationConfig {
  /** Max concurrent optimization jobs (default 1, conservative for CPU). */
  maxConcurrentJobs: number;
  /** Keep original files after successful conversion. */
  keepOriginals: boolean;
  /** Automatically optimize new downloads. */
  autoOptimize: boolean;
  /** Queue is paused — running jobs finish but no new ones start. */
  paused: boolean;
  /** Which media types to optimize: "all", "movies", or "tv". Defaults to "all". */
  mediaTypes: "all" | "movies" | "tv";
}

/** Optimization job status returned by the API. */
export interface OptimizationJob {
  id: string;
  sourcePath: string;
  targetPath: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  sourceCodec: string;
  sourceAudioCodec: string;
  sourceContainer: string;
  progress: number;
  durationSecs: number;
  fileSize: number;
  outputSize: number | null;
  keepOriginal: boolean;
  priority: number;
  error: string | null;
  retryCount: number;
  retryStrategy: string | null;
  lastCommand: string | null;
  /** Structured AI diagnosis of the failure (separate from raw error) */
  aiDiagnosis: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** File analysis result — tells whether a file needs optimization. */
export interface FileAnalysis {
  needsOptimization: boolean;
  reason: string;
  sourceCodec: string;
  sourceAudioCodec: string;
  sourceContainer: string;
  canDirectPlay: boolean;
  canTransmux: boolean;
}

/** Persistent scan result for a single file — cached in the DB. */
export interface LibraryScanEntry {
  filePath: string;
  videoCodec: string;
  audioCodec: string;
  container: string;
  needsOptimization: boolean;
  reason: string;
  canTransmux: boolean;
  fileSize: number;
  fileMtime: number;
  lastProbed: string;
  directory: string;
}

/** Summary of library health — aggregated from scan results. */
export interface LibraryHealthSummary {
  totalFiles: number;
  optimal: number;
  needsOptimization: number;
  needsTransmux: number;
  needsAudioConvert: number;
  needsFullTranscode: number;
  totalSizeBytes: number;
  lastScanAt: string | null;
  directories: string[];
}

/** Scan result returned from the scan endpoint — includes breakdown. */
export interface ScanResult {
  scanned: number;
  queued: number;
  skipped: number;
  breakdown: {
    transmux: number;
    audioReencode: number;
    fullTranscode: number;
  };
  lastScanAt: string;
}

/** Smart transcoding probe result — tells client whether transcoding is needed. */
export interface TranscodeDecision {
  /** Whether the source can be played directly without any processing. */
  canDirectPlay: boolean;
  /** Whether the source only needs container remux (no video re-encode). */
  canTransmux: boolean;
  /** Whether full HLS transcoding is required. */
  needsTranscode: boolean;
  /** Source video codec. */
  sourceCodec: string;
  /** Source container format. */
  sourceContainer: string;
  /** Reason for the decision. */
  reason: string;
}
