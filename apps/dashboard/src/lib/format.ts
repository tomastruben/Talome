const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * Bytes for storage and transfer ("410 GB"). A value that isn't a real byte
 * count (NaN, Infinity, negative) renders as an em dash rather than "NaN
 * undefined", so a failed stat never looks like data.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1) return "0 B";
  const k = 1024;
  const i = Math.min(BYTE_UNITS.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${BYTE_UNITS[i]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

/**
 * "just now", "5 min ago", "3 hr ago", "2d ago". A missing or unparseable
 * timestamp is "Never", never "NaNd ago" or "Invalid Date".
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "Never";
  const diff = Date.now() - time;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
