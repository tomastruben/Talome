import type { DownloadQueueItem, DownloadTorrent } from "@talome/types";

export type DownloadDisplayStatus =
  | "stalled"
  | "failed"
  | "warning"
  | "completed"
  | "downloading"
  | "paused"
  | "queued"
  | string;

export type TorrentDisplayStatus = {
  label: string;
  detail: string | null;
  tone: "default" | "healthy" | "warning" | "critical";
};

const STALLED_MESSAGE = /\b(?:stalled|no connections?|no (?:available )?seeders?)\b/i;

export function isStalledDownload(item: DownloadQueueItem): boolean {
  if (item.torrentState === "stalledDL") return true;
  if (item.status !== "warning") return false;

  return [item.errorMessage, ...(item.statusMessages ?? [])]
    .filter((message): message is string => typeof message === "string")
    .some((message) => STALLED_MESSAGE.test(message));
}

export function getDownloadDisplayStatus(item: DownloadQueueItem): DownloadDisplayStatus {
  if (item.status === "failed") return "failed";
  if (isStalledDownload(item)) return "stalled";
  if (getQueueActivity(item) === "completed") return "completed";
  if (item.status === "warning") return "warning";
  if (item.status) return item.status;
  return (item.dlspeed ?? 0) > 0 ? "downloading" : "queued";
}

const COMPLETE_TORRENT_STATES = new Set([
  "uploading",
  "stalledUP",
  "pausedUP",
  "stoppedUP",
  "queuedUP",
  "forcedUP",
  "checkingUP",
]);

export type DownloadActivity = "active" | "waiting" | "attention" | "processing" | "completed";
const TRANSFERRING_STATES = new Set(["downloading", "forcedDL", "metaDL", "forcedMetaDL", "allocating", "checkingDL"]);
const WAITING_STATES = new Set(["pausedDL", "stoppedDL", "queuedDL"]);

/** Completion requires actual completion, not a percentage rounded to 100. */
export function getQueueProgress(item: Pick<DownloadQueueItem, "progress" | "size" | "sizeleft">): number {
  const progress = Number.isFinite(item.progress)
    ? item.progress!
    : item.size > 0 && Number.isFinite(item.sizeleft) ? (item.size - item.sizeleft) / item.size : 0;
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
}

export function getQueueActivity(item: DownloadQueueItem): DownloadActivity {
  const status = item.status?.toLowerCase() ?? "";
  if (["failed", "warning", "stalled"].includes(status) || isStalledDownload(item) || ["missingFiles", "error"].includes(item.torrentState ?? "")) return "attention";
  if (["importpending", "importing", "pendingimport", "moving"].includes(status)) return "processing";
  if (status === "completed" || getQueueProgress(item) >= 1 || COMPLETE_TORRENT_STATES.has(item.torrentState ?? "")) return "completed";
  if (WAITING_STATES.has(item.torrentState ?? "") || ["paused", "queued", "stopped"].includes(status)) return "waiting";
  if (status === "downloading" || TRANSFERRING_STATES.has(item.torrentState ?? "")) return "active";
  return "waiting";
}

export function getTorrentActivity(torrent: DownloadTorrent): DownloadActivity {
  if (["missingFiles", "error", "stalledDL"].includes(torrent.state)) return "attention";
  if (torrent.progress >= 1 || COMPLETE_TORRENT_STATES.has(torrent.state)) return "completed";
  return TRANSFERRING_STATES.has(torrent.state) ? "active" : "waiting";
}

/** One definition for widget, navigation badge, and Control Center activity. */
export function getDownloadActivity(queue: DownloadQueueItem[], torrents: DownloadTorrent[]) {
  const activeQueue = queue.filter((item) => getQueueActivity(item) === "active");
  const activeTorrents = torrents.filter((item) => getTorrentActivity(item) === "active");
  const counts: Record<DownloadActivity, number> = { active: 0, waiting: 0, attention: 0, processing: 0, completed: 0 };
  for (const item of queue) counts[getQueueActivity(item)]++;
  for (const item of torrents) counts[getTorrentActivity(item)]++;
  const secondary = [
    counts.attention ? `${counts.attention} need attention` : "",
    counts.processing ? `${counts.processing} importing` : "",
    counts.waiting ? `${counts.waiting} waiting` : "",
    counts.completed ? `${counts.completed} completed` : "",
  ].filter(Boolean).join(" · ");
  return { activeQueue, activeTorrents, activeCount: counts.active, counts, secondary,
    pendingCount: counts.active + counts.waiting + counts.attention + counts.processing };
}

export function getDownloadCompletionSnapshot(queue: DownloadQueueItem[], torrents: DownloadTorrent[]) {
  return new Map([
    ...queue.map((item) => [`queue:${item.type}:${item.id}`, { title: item.title, complete: ["completed", "processing"].includes(getQueueActivity(item)) }] as const),
    ...torrents.map((item) => [`torrent:${item.hash}`, { title: item.name, complete: getTorrentActivity(item) === "completed" }] as const),
  ]);
}

export function getNewlyCompletedDownloads(previous: ReturnType<typeof getDownloadCompletionSnapshot>, current: ReturnType<typeof getDownloadCompletionSnapshot>): string[] {
  return [...current].filter(([key, item]) => item.complete && previous.get(key)?.complete === false).map(([, item]) => item.title);
}

function humanizeTorrentState(state: string): string {
  const expanded = state
    .replace(/DL$/i, " download")
    .replace(/UP$/i, " upload")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

  return expanded
    ? expanded.charAt(0).toUpperCase() + expanded.slice(1).toLowerCase()
    : "Waiting";
}

/**
 * Raw torrents are returned only when Sonarr or Radarr no longer has a matching
 * queue item. Describe that missing link directly instead of exposing qBittorrent
 * state codes such as `stoppedUP`.
 */
export function getTorrentDisplayStatus(
  torrent: Pick<DownloadTorrent, "state" | "progress">,
): TorrentDisplayStatus {
  if (torrent.state === "missingFiles") {
    return {
      label: "Files missing",
      detail: "The download client cannot find the downloaded files.",
      tone: "critical",
    };
  }

  const isComplete = torrent.progress >= 1 || COMPLETE_TORRENT_STATES.has(torrent.state);
  if (isComplete) {
    const seedingDetail = (() => {
      switch (torrent.state) {
        case "uploading":
        case "forcedUP":
        case "queuedUP":
          return "Seeding";
        case "stalledUP":
          return "Seeding is idle";
        case "pausedUP":
        case "stoppedUP":
          return "Seeding stopped";
        case "checkingUP":
          return "Verifying downloaded files";
        default:
          return "Download complete";
      }
    })();

    return {
      label: "Downloaded",
      detail: `${seedingDetail} · Library import not confirmed`,
      tone: torrent.state === "uploading" || torrent.state === "forcedUP" ? "healthy" : "warning",
    };
  }

  const statuses: Record<string, TorrentDisplayStatus> = {
    downloading: { label: "Downloading", detail: null, tone: "default" },
    forcedDL: { label: "Downloading", detail: "Forced download", tone: "default" },
    metaDL: { label: "Starting", detail: "Fetching download metadata", tone: "default" },
    stalledDL: {
      label: "Stalled",
      detail: "No active peers are sending data.",
      tone: "warning",
    },
    pausedDL: { label: "Paused", detail: "Download paused", tone: "default" },
    stoppedDL: { label: "Stopped", detail: "Download stopped", tone: "warning" },
    queuedDL: { label: "Queued", detail: "Waiting to download", tone: "default" },
    checkingDL: { label: "Checking", detail: "Verifying downloaded data", tone: "default" },
    allocating: { label: "Preparing", detail: "Allocating disk space", tone: "default" },
  };

  return statuses[torrent.state] ?? {
    label: humanizeTorrentState(torrent.state),
    detail: null,
    tone: "default",
  };
}

function plural(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export function formatDownloadAge(addedOn: number, nowMs = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1000) - addedOn);
  if (elapsedSeconds < 60) return "<1m";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h`;
  return `${Math.floor(elapsedSeconds / 86400)}d`;
}

export function getDownloadHealthFacts(item: DownloadQueueItem, nowMs = Date.now()): string[] {
  const facts: string[] = [];
  const connectedSeeds = item.connectedSeeds;
  const connectedLeechers = item.connectedLeechers;
  if (connectedSeeds != null || connectedLeechers != null) {
    facts.push(`${(connectedSeeds ?? 0) + (connectedLeechers ?? 0)} connected`);
  }

  if (item.swarmSeeds != null || item.swarmLeechers != null) {
    facts.push(
      `${plural(item.swarmSeeds ?? 0, "seed")} · ${plural(item.swarmLeechers ?? 0, "peer")} in swarm`,
    );
  }

  if (item.availability != null) {
    facts.push(`${Math.round(Math.max(0, item.availability) * 100)}% available`);
  }

  if (item.addedOn != null && item.addedOn > 0) {
    facts.push(`added ${formatDownloadAge(item.addedOn, nowMs)} ago`);
  }

  return facts;
}
