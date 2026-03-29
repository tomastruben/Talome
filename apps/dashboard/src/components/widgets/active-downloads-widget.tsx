"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { HugeiconsIcon, Film01Icon, Tv01Icon, ArrowDown01Icon, Download01Icon } from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";
import { Widget, WidgetHeader } from "./widget";
import { useDownloads } from "@/hooks/use-downloads";
import type { DownloadQueueItem, DownloadTorrent } from "@talome/types";
import { WidgetList, WidgetListState } from "./list-widget";

function formatSpeed(bps: number): string {
  if (!bps) return "";
  const mb = bps / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0 || seconds > 86400 * 7) return "";
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} hr`;
}

function QueueItemRow({ item }: { item: DownloadQueueItem }) {
  const pct = Math.round((item.progress ?? 0) * 100);
  const speed = formatSpeed(item.dlspeed ?? 0);
  const eta = formatEta(item.eta);

  return (
    <div className="px-4 py-2.5 grid gap-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <HugeiconsIcon icon={item.type === "tv" ? Tv01Icon : Film01Icon} size={13} className="text-dim-foreground shrink-0" />
        <p className="text-sm font-medium truncate flex-1">{item.title}</p>
        <span className="text-xs tabular-nums font-medium text-muted-foreground shrink-0">{pct}%</span>
      </div>
      <Progress value={pct} className="h-1" />
      <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums min-w-0">
        {item.size > 0 && (
          <span className="truncate">
            {formatBytes(item.size * (item.progress ?? 0))} of {formatBytes(item.size)}
          </span>
        )}
        {speed && (
          <span className="flex items-center gap-1 shrink-0">
            <HugeiconsIcon icon={ArrowDown01Icon} size={10} />
            {speed}
          </span>
        )}
        {eta && <span className="ml-auto shrink-0">{eta}</span>}
      </div>
    </div>
  );
}

function TorrentRow({ torrent }: { torrent: DownloadTorrent }) {
  const pct = Math.round(torrent.progress * 100);
  const speed = formatSpeed(torrent.dlspeed);
  const eta = formatEta(torrent.eta);

  return (
    <div className="px-4 py-2.5 grid gap-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <HugeiconsIcon icon={Film01Icon} size={13} className="text-dim-foreground shrink-0" />
        <p className="text-sm font-medium truncate flex-1">{torrent.name}</p>
        <span className="text-xs tabular-nums font-medium text-muted-foreground shrink-0">{pct}%</span>
      </div>
      <Progress value={pct} className="h-1" />
      <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums min-w-0">
        <span className="truncate">
          {formatBytes(torrent.size * torrent.progress)} of {formatBytes(torrent.size)}
        </span>
        {speed && (
          <span className="flex items-center gap-1 shrink-0">
            <HugeiconsIcon icon={ArrowDown01Icon} size={10} />
            {speed}
          </span>
        )}
        {eta && <span className="ml-auto shrink-0">{eta}</span>}
      </div>
    </div>
  );
}

export function ActiveDownloadsWidget() {
  const { data, queue, torrents, isLoading, error } = useDownloads();
  const activeTorrents = torrents.filter((t) => t.state === "downloading");
  const activeCount = queue.length + activeTorrents.length;

  // Track previous torrent hashes for completion detection
  const prevTorrentHashesRef = useRef<Set<string> | null>(null);
  // Track previous queue item IDs + status for queue completion detection
  const prevQueueRef = useRef<Map<number, string> | null>(null);

  useEffect(() => {
    if (!data) return;

    // Torrent completion: hash disappears
    const currentHashes = new Set(torrents.map((t) => t.hash));
    if (prevTorrentHashesRef.current !== null) {
      prevTorrentHashesRef.current.forEach((hash) => {
        if (!currentHashes.has(hash)) {
          toast.success("Download complete", {
            action: {
              label: "View",
              onClick: () => window.location.assign("/dashboard/media?tab=downloads"),
            },
          });
        }
      });
    }
    prevTorrentHashesRef.current = currentHashes;

    // Queue completion: status transitions to completed or importPending
    const currentQueueMap = new Map(queue.map((q) => [q.id, q.status]));
    if (prevQueueRef.current !== null) {
      prevQueueRef.current.forEach((prevStatus, id) => {
        const newStatus = currentQueueMap.get(id);
        if (
          prevStatus === "downloading" &&
          (newStatus === "completed" || newStatus === "importPending" || newStatus === "importing")
        ) {
          const item = queue.find((q) => q.id === id);
          toast.success(`Downloaded: ${item?.title ?? "item"}`, {
            action: {
              label: "View",
              onClick: () => window.location.assign("/dashboard/media?tab=downloads"),
            },
          });
        }
      });
    }
    prevQueueRef.current = currentQueueMap;
  }, [data, torrents, queue]);

  const displayQueue = queue;
  const displayTorrents = activeTorrents;

  return (
    <Widget>
      <WidgetHeader
        title="Active Downloads"
        href="/dashboard/media?tab=downloads"
        hrefLabel={activeCount > 0 ? `${activeCount} active` : "View all"}
      />
      {isLoading ? (
        <WidgetListState icon={Download01Icon} message="Loading active downloads..." />
      ) : error ? (
        <WidgetListState icon={Download01Icon} message="Download stats unavailable." />
      ) : displayQueue.length === 0 && displayTorrents.length === 0 ? (
        <WidgetListState icon={Download01Icon} message="No active downloads." />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {displayQueue.map((item) => (
              <QueueItemRow key={`q-${item.id}`} item={item} />
            ))}
            {displayTorrents.map((torrent) => (
              <TorrentRow key={torrent.hash} torrent={torrent} />
            ))}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
