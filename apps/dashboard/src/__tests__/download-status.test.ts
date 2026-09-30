import { describe, expect, it } from "vitest";
import type { DownloadQueueItem } from "@talome/types";
import {
  getDownloadDisplayStatus,
  getDownloadHealthFacts,
  getTorrentDisplayStatus,
  isStalledDownload,
  getDownloadActivity,
  getDownloadCompletionSnapshot,
  getNewlyCompletedDownloads,
  getQueueActivity,
  getTorrentActivity,
} from "@/lib/download-status";

const baseItem: DownloadQueueItem = {
  id: 1,
  title: "Devs.S01E01",
  status: "warning",
  size: 1_000,
  sizeleft: 1_000,
  type: "tv",
  estimatedCompletionTime: null,
};

describe("download status presentation", () => {
  it("presents a Sonarr stalled warning as stalled, not failed", () => {
    const item = {
      ...baseItem,
      torrentState: "stalledDL",
      errorMessage: "The download is stalled with no connections",
    };

    expect(isStalledDownload(item)).toBe(true);
    expect(getDownloadDisplayStatus(item)).toBe("stalled");
  });

  it("keeps unrelated Sonarr warnings distinct from failures", () => {
    expect(getDownloadDisplayStatus({ ...baseItem, errorMessage: "Import pending" })).toBe("warning");
    expect(getDownloadDisplayStatus({ ...baseItem, status: "failed" })).toBe("failed");
  });

  it("describes live swarm state and torrent age", () => {
    const facts = getDownloadHealthFacts({
      ...baseItem,
      connectedSeeds: 0,
      connectedLeechers: 0,
      swarmSeeds: 0,
      swarmLeechers: 1,
      availability: 0,
      addedOn: 1_000,
    }, 1_720_000);

    expect(facts).toEqual([
      "0 connected",
      "0 seeds · 1 peer in swarm",
      "0% available",
      "added 12m ago",
    ]);
  });

  it("explains stoppedUP as a completed download with an unconfirmed import", () => {
    expect(getTorrentDisplayStatus({ state: "stoppedUP", progress: 1 })).toEqual({
      label: "Downloaded",
      detail: "Seeding stopped · Library import not confirmed",
      tone: "warning",
    });
  });

  it("keeps active seeding distinct from an active download", () => {
    expect(getTorrentDisplayStatus({ state: "uploading", progress: 1 })).toEqual({
      label: "Downloaded",
      detail: "Seeding · Library import not confirmed",
      tone: "healthy",
    });
    expect(getTorrentDisplayStatus({ state: "downloading", progress: 0.42 })).toEqual({
      label: "Downloading",
      detail: null,
      tone: "default",
    });
  });

  it("turns other qBittorrent codes into readable fallback labels", () => {
    expect(getTorrentDisplayStatus({ state: "someFutureDL", progress: 0.2 }).label)
      .toBe("Some future download");
  });
});

describe("shared download activity", () => {
  const torrent = { hash: "transfer", name: "Transfer", size: 1000, progress: 0.5, dlspeed: 100, upspeed: 0, state: "downloading", eta: 5 };
  it("excludes completed transfers and imports from active counts while preserving their status", () => {
    const queue = [
      { ...baseItem, status: "completed", progress: 1 },
      { ...baseItem, id: 2, status: "downloading", progress: 1 },
      { ...baseItem, id: 3, status: "importPending", progress: 1 },
      { ...baseItem, id: 4, status: "warning", progress: 1, errorMessage: "Import needs review" },
    ];
    const summary = getDownloadActivity(queue, [{ ...torrent, state: "stoppedUP", progress: 1 }]);
    expect(summary.activeCount).toBe(0);
    expect(summary.counts).toEqual({ active: 0, waiting: 0, attention: 1, processing: 1, completed: 3 });
    expect(summary.pendingCount).toBe(2);
  });

  it("keeps incomplete near-100% and forced transfers active, but separates pauses and stalls", () => {
    expect(getQueueActivity({ ...baseItem, status: "downloading", progress: 0.9999 })).toBe("active");
    expect(getTorrentActivity({ ...torrent, state: "forcedDL" })).toBe("active");
    expect(getTorrentDisplayStatus({ ...torrent, progress: 0.9999 }).label).toBe("Downloading");
    expect(getQueueActivity({ ...baseItem, status: "downloading", torrentState: "pausedDL" })).toBe("waiting");
    expect(getQueueActivity({ ...baseItem, status: "downloading", torrentState: "stalledDL" })).toBe("attention");
  });

  it("does not report deletions or first-seen items as completions", () => {
    const before = getDownloadCompletionSnapshot([], [torrent]);
    expect(getNewlyCompletedDownloads(before, getDownloadCompletionSnapshot([], []))).toEqual([]);
    expect(getNewlyCompletedDownloads(new Map(), getDownloadCompletionSnapshot([], [{ ...torrent, progress: 1 }]))).toEqual([]);
    expect(getNewlyCompletedDownloads(before, getDownloadCompletionSnapshot([], [{ ...torrent, progress: 1, state: "uploading" }]))).toEqual(["Transfer"]);
  });

  it("keeps movie and TV queue IDs distinct when detecting completion", () => {
    const before = getDownloadCompletionSnapshot([{ ...baseItem, status: "downloading", progress: 0.5 }], []);
    const otherQueue = getDownloadCompletionSnapshot([{ ...baseItem, type: "movie", status: "completed", progress: 1 }], []);
    expect(getNewlyCompletedDownloads(before, otherQueue)).toEqual([]);
  });
});
