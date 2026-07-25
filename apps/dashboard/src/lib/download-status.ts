import type { DownloadQueueItem } from "@talome/types";

export type DownloadDisplayStatus =
  | "stalled"
  | "failed"
  | "warning"
  | "completed"
  | "downloading"
  | "paused"
  | "queued"
  | string;

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
  if (item.status === "completed") return "completed";
  if (item.status === "warning") return "warning";
  if (item.status) return item.status;
  return (item.dlspeed ?? 0) > 0 ? "downloading" : "queued";
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
