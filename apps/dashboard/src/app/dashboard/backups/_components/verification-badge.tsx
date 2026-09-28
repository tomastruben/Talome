"use client";

import {
  HugeiconsIcon,
  CheckmarkCircle02Icon,
  AlertCircleIcon,
  Clock01Icon,
} from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime } from "@/components/settings/settings-primitives";
import { cn } from "@/lib/utils";
import { VERIFICATION_LABELS, verificationState } from "../_lib/backup-status";
import type { BackupSummary } from "../_lib/types";

export function VerificationBadge({ backup, className }: { backup: BackupSummary | null | undefined; className?: string }) {
  const state = verificationState(backup);
  const label = VERIFICATION_LABELS[state];

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap",
        state === "verified" && "text-status-healthy",
        state === "failed" && "text-status-critical",
        (state === "unverified" || state === "verifying" || state === "none") && "text-muted-foreground",
        className,
      )}
    >
      {state === "verified" && <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} />}
      {state === "failed" && <HugeiconsIcon icon={AlertCircleIcon} size={14} />}
      {state === "unverified" && <HugeiconsIcon icon={Clock01Icon} size={14} />}
      {state === "verifying" && <Spinner className="size-3.5" />}
      {state === "none" ? "—" : label}
    </span>
  );

  if (!backup?.verifiedAt || state === "verifying") return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>Checked {relativeTime(backup.verifiedAt)}</TooltipContent>
    </Tooltip>
  );
}
