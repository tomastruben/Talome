export type StatusTone = "healthy" | "warning" | "critical" | "muted";

/** Text colour for a status tone (theme tokens from globals.css). */
export const TONE_TEXT: Record<StatusTone, string> = {
  healthy: "text-status-healthy",
  warning: "text-status-warning",
  critical: "text-status-critical",
  muted: "text-muted-foreground",
};

/** Small status dot background for a status tone. */
export const TONE_DOT: Record<StatusTone, string> = {
  healthy: "bg-status-healthy",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
  muted: "bg-muted-foreground/60",
};
