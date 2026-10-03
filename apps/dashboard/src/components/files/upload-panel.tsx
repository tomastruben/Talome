"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  HugeiconsIcon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Refresh01Icon,
} from "@/components/icons";
import { SuccessCheck } from "@/components/ui/micro";
import { formatBytes } from "@/lib/format";
import { DURATION, TRAVEL, enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { UploadItem } from "./use-upload-queue";

function statusText(item: UploadItem): string {
  switch (item.status) {
    case "queued":
      return `Waiting · ${formatBytes(item.file.size)}`;
    case "uploading":
      return `${formatBytes(item.loaded)} of ${formatBytes(item.file.size)}`;
    case "done":
      return item.savedAs && item.savedAs !== item.relativePath.split("/").pop() ? `Saved as ${item.savedAs}` : formatBytes(item.file.size);
    case "skipped":
      return "Already exists — skipped";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return item.error ?? "Failed";
  }
}

/** Upload progress, pinned to the bottom-right of the Files page while uploads exist. */
export function UploadPanel({
  items,
  onCancel,
  onCancelAll,
  onRetry,
  onClear,
}: {
  items: UploadItem[];
  onCancel: (id: string) => void;
  onCancelAll: () => void;
  onRetry: (id: string) => void;
  onClear: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const totalBytes = items.reduce((sum, i) => sum + i.file.size, 0);
  const doneBytes = items.reduce((sum, i) => sum + (i.status === "done" || i.status === "skipped" ? i.file.size : i.loaded), 0);
  const remaining = items.filter((i) => i.status === "queued" || i.status === "uploading").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const finished = items.length - remaining;
  const percent = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 100;

  const title =
    remaining > 0
      ? `Uploading ${finished + 1 > items.length ? items.length : finished + 1} of ${items.length}`
      : failed > 0
        ? `${failed} upload${failed === 1 ? "" : "s"} failed`
        : `${items.length} upload${items.length === 1 ? "" : "s"} complete`;

  return (
    <AnimatePresence>
      {items.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: TRAVEL.lift }}
          animate={{ opacity: 1, y: 0, transition: enter(DURATION.pill) }}
          exit={{ opacity: 0, y: TRAVEL.rise, transition: exit(DURATION.exitFast) }}
          // Clear of an iPhone's home indicator (the safe area is 0 elsewhere)
          className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 w-[calc(100vw-2rem)] sm:w-96 rounded-xl border bg-card shadow-lg overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{title}</p>
              {remaining > 0 && (
                <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                  {formatBytes(doneBytes)} of {formatBytes(totalBytes)} · {percent}%
                </p>
              )}
            </div>
            {remaining > 0 ? (
              <Button variant="ghost" size="sm" className="h-7 text-xs phone-touch:h-11" onClick={onCancelAll}>
                Cancel all
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 text-xs phone-touch:h-11" onClick={onClear}>
                Done
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 phone-touch:size-11"
              aria-label={collapsed ? "Show uploads" : "Hide uploads"}
              onClick={() => setCollapsed((c) => !c)}
            >
              <HugeiconsIcon icon={collapsed ? ArrowUp01Icon : ArrowDown01Icon} size={14} />
            </Button>
          </div>
          {remaining > 0 && <Progress value={percent} className="h-0.5 rounded-none" />}

          {!collapsed && (
            <ul className="max-h-72 overflow-y-auto border-t divide-y">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate" title={item.relativePath}>{item.relativePath}</p>
                    <p
                      className={cn(
                        "text-xs tabular-nums truncate mt-0.5",
                        item.status === "failed" ? "text-status-critical" : "text-muted-foreground",
                      )}
                    >
                      {statusText(item)}
                    </p>
                    {item.status === "uploading" && (
                      <Progress value={item.file.size > 0 ? (item.loaded / item.file.size) * 100 : 0} className="h-1 mt-1.5" />
                    )}
                  </div>
                  {(item.status === "queued" || item.status === "uploading") && (
                    <Button variant="ghost" size="icon" className="size-7 shrink-0 phone-touch:size-11" aria-label={`Cancel ${item.relativePath}`} onClick={() => onCancel(item.id)}>
                      <HugeiconsIcon icon={Cancel01Icon} size={14} />
                    </Button>
                  )}
                  {(item.status === "failed" || item.status === "cancelled") && (
                    <Button variant="ghost" size="icon" className="size-7 shrink-0 phone-touch:size-11" aria-label={`Retry ${item.relativePath}`} onClick={() => onRetry(item.id)}>
                      <HugeiconsIcon icon={Refresh01Icon} size={14} />
                    </Button>
                  )}
                  {item.status === "done" && (
                    <SuccessCheck size={16} className="shrink-0 mr-1.5" />
                  )}
                  {item.status === "failed" && (
                    <HugeiconsIcon icon={AlertCircleIcon} size={16} className="text-status-critical shrink-0" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
