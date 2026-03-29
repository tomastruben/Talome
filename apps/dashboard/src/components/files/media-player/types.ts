import type { IconSvgElement } from "@/components/icons";

// ── Track info from probe / Jellyfin ────────────────────────────────────

export interface AudioTrackInfo {
  index: number;
  codec: string;
  language: string;
  title: string;
  channels: number;
}

export interface SubtitleTrackInfo {
  index: number;
  codec: string;
  language: string;
  title: string;
  textBased: boolean;
  /** Jellyfin external subtitle URL (optional). */
  deliveryUrl?: string;
  isDefault?: boolean;
}

// ── Playback mode ───────────────────────────────────────────────────────

export type PlaybackMode =
  | "direct"
  | "direct-mkv"
  | "hls"
  | "transmux"
  | "jellyfin"
  | "jellyfin-hls"
  | "deciding";

// ── Fullscreen / TV settings ────────────────────────────────────────────

export interface FsSettings {
  seekStep: number;
  largeSeekStep: number;
  volumeStep: number;
  controlsHideDelay: number;
  showInfoOnStart: boolean;
}

export const FS_DEFAULTS: FsSettings = {
  seekStep: 10,
  largeSeekStep: 30,
  volumeStep: 0.1,
  controlsHideDelay: 4000,
  showInfoOnStart: true,
};

export const FS_SETTINGS_KEY = "talome-fullscreen-media-settings";

// ── Subtitle styling ────────────────────────────────────────────────────

export type SubtitleFontSize = "small" | "medium" | "large" | "xlarge";

export interface SubtitleStyle {
  fontSize: SubtitleFontSize;
  bgOpacity: number;
}

export const SUBTITLE_STYLE_KEY = "talome-subtitle-style";

export const SUBTITLE_DEFAULTS: SubtitleStyle = {
  fontSize: "medium",
  bgOpacity: 0.75,
};

export const SUBTITLE_FONT_SIZES: Record<SubtitleFontSize, string> = {
  small: "0.8em",
  medium: "1em",
  large: "1.2em",
  xlarge: "1.5em",
};

// ── Jellyfin session ────────────────────────────────────────────────────

export interface JellyfinSession {
  jellyfinBaseUrl: string;
  apiKey: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
}

// ── Chapter info (Jellyfin) ─────────────────────────────────────────────

export interface ChapterInfo {
  startSeconds: number;
  name: string;
}

// ── Trickplay (seek thumbnails) ─────────────────────────────────────────

export interface TrickplayInfo {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  thumbnailCount: number;
  interval: number; // ms between thumbnails
  baseUrl: string;
}

// ── Quality level (HLS.js) ──────────────────────────────────────────────

export interface QualityLevel {
  index: number;
  height: number;
  width: number;
  bitrate: number;
}

// ── Shared constants ────────────────────────────────────────────────────

/** Extensions that browsers can play directly (no HLS needed). */
export const DIRECT_PLAY_EXTS = new Set(["mp4", "m4v", "mov", "webm"]);

/** Extensions that always need HLS transcoding. */
export const HLS_EXTS = new Set(["mkv", "avi", "wmv", "flv", "ts"]);

/** Browser-native audio codecs. */
export const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/** Playback speed options (shared between Video and Audio players). */
export const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;

export const SPEED_KEY = "talome-player-speed";

// ── VideoPlayer props ───────────────────────────────────────────────────

export interface VideoPlayerProps {
  src: string;
  fileName: string;
  filePath: string;
  apiBase?: string;
  onEnded?: () => void;
  /** Automatically enter fullscreen on mount. */
  autoFullscreen?: boolean;
  /** Called when exiting fullscreen (useful with autoFullscreen to unmount the player). */
  onExitFullscreen?: () => void;
  /** When true, hides fullscreen button and shows back button in top bar. */
  cinemaMode?: boolean;
  /** Called when user clicks Back in cinema mode. */
  onBack?: () => void;
  /** Called when user requests next episode. */
  onNext?: () => void;
  /** Called when user requests previous episode. */
  onPrevious?: () => void;
  /** Title of the next item (for "Up Next" overlay). */
  nextLabel?: string;
  /** Title of the previous item. */
  previousLabel?: string;
  /** When true, prefer original/direct-play quality over transcoded streams. */
  preferOriginal?: boolean;
}

export interface AudioPlayerProps {
  src: string;
  fileName: string;
  fileIcon: IconSvgElement;
  fileIconColor: string;
}
