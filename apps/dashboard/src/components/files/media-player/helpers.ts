import {
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeMute01Icon,
  VolumeOffIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import {
  FS_SETTINGS_KEY,
  FS_DEFAULTS,
  SUBTITLE_STYLE_KEY,
  SUBTITLE_DEFAULTS,
  SPEED_KEY,
  DIRECT_PLAY_EXTS,
  HLS_EXTS,
  type FsSettings,
  type SubtitleStyle,
} from "./types";

// ── Time formatting ─────────────────────────────────────────────────────

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Volume icon picker ──────────────────────────────────────────────────

export function getVolumeIcon({ volume, muted }: { volume: number; muted: boolean }): IconSvgElement {
  if (muted || volume === 0) return VolumeOffIcon;
  if (volume < 0.33) return VolumeMute01Icon;
  if (volume < 0.66) return VolumeLowIcon;
  return VolumeHighIcon;
}

// ── Language / track labels ─────────────────────────────────────────────

/** ISO 639 language code → human label. */
export function langLabel(code: string): string {
  const map: Record<string, string> = {
    eng: "English", jpn: "Japanese", spa: "Spanish", fre: "French", fra: "French",
    ger: "German", deu: "German", ita: "Italian", por: "Portuguese", rus: "Russian",
    chi: "Chinese", zho: "Chinese", kor: "Korean", ara: "Arabic", hin: "Hindi",
    pol: "Polish", dut: "Dutch", nld: "Dutch", swe: "Swedish", nor: "Norwegian",
    dan: "Danish", fin: "Finnish", tur: "Turkish", tha: "Thai", vie: "Vietnamese",
    und: "Unknown",
  };
  return map[code] ?? code.toUpperCase();
}

export function trackLabel(track: { language: string; title: string; index: number }, fallback: string): string {
  if (track.title) return track.title;
  if (track.language && track.language !== "und") return langLabel(track.language);
  return `${fallback} ${track.index + 1}`;
}

// ── File helpers ─────────────────────────────────────────────────────────

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function needsHls(fileName: string): boolean {
  const ext = fileExt(fileName);
  if (DIRECT_PLAY_EXTS.has(ext)) return false;
  if (HLS_EXTS.has(ext)) return true;
  return false;
}

// ── Browser detection ───────────────────────────────────────────────────

/** Only Safari has reliable HEVC HLS playback (including 10-bit Main 10 profile). */
export function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium");
}

/** Check if browser supports HEVC via MSE (Chrome 107+ on macOS/Windows with HW decode). */
export function supportsHevc(): boolean {
  if (typeof MediaSource === "undefined") return false;
  return MediaSource.isTypeSupported('video/mp4;codecs="hev1.1.6.L153.B0"');
}

/** Check if Picture-in-Picture is supported. */
export function supportsPiP(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.pictureInPictureEnabled;
}

/** Check if AirPlay is available (Safari only). */
export function supportsAirPlay(): boolean {
  if (typeof window === "undefined") return false;
  return "WebKitPlaybackTargetAvailabilityEvent" in window;
}

// ── Settings persistence ────────────────────────────────────────────────

export function loadFsSettings(): FsSettings {
  if (typeof localStorage === "undefined") return FS_DEFAULTS;
  try {
    const raw = localStorage.getItem(FS_SETTINGS_KEY);
    return raw ? { ...FS_DEFAULTS, ...JSON.parse(raw) } : FS_DEFAULTS;
  } catch { return FS_DEFAULTS; }
}

export function loadSubtitleStyle(): SubtitleStyle {
  if (typeof localStorage === "undefined") return SUBTITLE_DEFAULTS;
  try {
    const raw = localStorage.getItem(SUBTITLE_STYLE_KEY);
    return raw ? { ...SUBTITLE_DEFAULTS, ...JSON.parse(raw) } : SUBTITLE_DEFAULTS;
  } catch { return SUBTITLE_DEFAULTS; }
}

export function saveSubtitleStyle(style: SubtitleStyle): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(style));
}

export function loadSpeed(): number {
  if (typeof localStorage === "undefined") return 1;
  try {
    const raw = localStorage.getItem(SPEED_KEY);
    return raw ? Number(raw) || 1 : 1;
  } catch { return 1; }
}

export function saveSpeed(speed: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SPEED_KEY, String(speed));
}

// ── Chapter detection ───────────────────────────────────────────────────

/** Check if a chapter name matches intro/opening patterns. */
export function isIntroChapter(name: string): boolean {
  return /\b(intro(duction)?|opening|op)\b/i.test(name);
}

/** Check if a chapter name matches credits/ending patterns. */
export function isCreditsChapter(name: string): boolean {
  return /\b(credits?|ending|ed)\b/i.test(name);
}
