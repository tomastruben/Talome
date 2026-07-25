import { describe, expect, it } from "vitest";
import type { DownloadQueueItem } from "@talome/types";
import {
  getDownloadDisplayStatus,
  getDownloadHealthFacts,
  isStalledDownload,
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
});
