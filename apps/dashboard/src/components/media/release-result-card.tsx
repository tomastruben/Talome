"use client";

import {
  HugeiconsIcon,
  Download01Icon,
  Tick01Icon,
  InformationCircleIcon,
  ArrowUp01Icon,
} from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface ReleaseResultCardData {
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

export function formatReleaseSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1048576).toFixed(0)} MB`;
}

function formatReleaseAge(hours: number | null | undefined): string {
  if (!hours && hours !== 0) return "";
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1d" : `${days}d`;
}

export function ReleaseResultCard({
  release,
  isSubmitting = false,
  isSubmitted = false,
  queuePercent = null,
  onAction,
}: {
  release: ReleaseResultCardData;
  isSubmitting?: boolean;
  isSubmitted?: boolean;
  queuePercent?: number | null;
  onAction: () => void;
}) {
  const seeders = release.seeders ?? 0;
  const isRejected = release.rejected === true;
  const rejectionReason = release.rejections?.[0];
  // Always allow download — the user is on the media's page, so we know the target.
  // Radarr's downloadAllowed=false is just a parsing warning, not a hard block.
  const canDownload = !!release.raw;
  const isQueued = queuePercent != null;

  // Compact metadata tokens
  const containerFmt = release.containerFormat?.toUpperCase() ?? null;
  const meta: string[] = [];
  if (release.quality) meta.push(release.quality);
  if (release.size) meta.push(formatReleaseSize(release.size));
  if (release.ageHours != null) meta.push(formatReleaseAge(release.ageHours));
  if (release.indexer) meta.push(release.indexer);

  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
      isQueued ? "border-primary/20 bg-primary/5"
        : isSubmitted ? "border-status-healthy/20 bg-status-healthy/5"
        : "border-border/30 hover:border-border/50",
    )}>
      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium leading-tight truncate">{release.title}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {containerFmt && (
            <span className={cn(
              "shrink-0 font-medium px-1 py-px rounded text-xs",
              containerFmt === "MP4" || containerFmt === "M4V"
                ? "bg-status-healthy/10 text-status-healthy"
                : "bg-muted text-muted-foreground"
            )}>
              {containerFmt}
            </span>
          )}
          {meta.length > 0 && (
            <span className="truncate">{meta.join(" · ")}</span>
          )}
          {seeders > 0 && (
            <span className="inline-flex items-center gap-0.5 shrink-0 tabular-nums">
              <HugeiconsIcon icon={ArrowUp01Icon} size={9} className="text-dim-foreground" />
              {seeders}
            </span>
          )}
        </div>
      </div>

      {/* Queue progress */}
      {isQueued && (
        <div className="flex items-center gap-1.5 shrink-0">
          <Progress value={queuePercent ?? 0} className="h-0.5 w-10" />
          <span className="text-xs tabular-nums text-primary/80">{queuePercent}%</span>
        </div>
      )}

      {/* Actions */}
      {!isQueued && (
        <div className="inline-flex items-center gap-0.5 shrink-0">
          {isRejected && rejectionReason && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-dim-foreground hover:text-foreground transition-colors"
                  aria-label="Why this release is not suitable"
                >
                  <HugeiconsIcon icon={InformationCircleIcon} size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[20rem] text-xs">
                {rejectionReason}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50",
                  isSubmitted
                    ? "text-status-healthy"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
                onClick={onAction}
                disabled={!canDownload || isSubmitting || isSubmitted}
                aria-label={
                  isSubmitted
                    ? "Sent to download client"
                    : isSubmitting
                      ? "Submitting..."
                      : "Download release"
                }
              >
                {isSubmitting ? (
                  <Spinner className="size-3" />
                ) : isSubmitted ? (
                  <HugeiconsIcon icon={Tick01Icon} size={13} />
                ) : (
                  <HugeiconsIcon icon={Download01Icon} size={13} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {isSubmitted
                ? "Sent to download client"
                : isSubmitting
                  ? "Submitting..."
                  : isRejected
                    ? "Download anyway"
                    : "Download"}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
