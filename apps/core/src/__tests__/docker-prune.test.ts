import { describe, expect, it } from "vitest";
import {
  classifyStoppedContainers,
  type StoppedContainerCandidate,
} from "../docker/client.js";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const ONE_DAY = 24 * 60 * 60 * 1000;

function candidate(
  overrides: Partial<StoppedContainerCandidate> = {},
): StoppedContainerCandidate {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "orphan",
    labels: {},
    stoppedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("classifyStoppedContainers", () => {
  it("protects an installed app by its last-known short container ID", () => {
    const container = candidate({ id: "283e09bdf4391234567890", name: "legacy-name" });

    const result = classifyStoppedContainers(
      [container],
      { ids: ["283e09bdf439"], appIds: [] },
      NOW,
      ONE_DAY,
    );

    expect(result.protected).toEqual([container]);
    expect(result.prunable).toEqual([]);
  });

  it("protects a recreated app by container name when its stored ID is stale", () => {
    const container = candidate({ id: "new-container-id", name: "sonarr" });

    const result = classifyStoppedContainers(
      [container],
      { ids: ["old-container-id"], appIds: ["sonarr"] },
      NOW,
      ONE_DAY,
    );

    expect(result.protected).toEqual([container]);
  });

  it("protects every service in an installed Compose project", () => {
    const container = candidate({
      id: "new-worker-id",
      name: "custom-worker-name",
      labels: {
        "com.docker.compose.project": "paperless-ngx",
        "com.docker.compose.service": "worker",
      },
    });

    const result = classifyStoppedContainers(
      [container],
      { ids: [], appIds: ["paperless-ngx"] },
      NOW,
      ONE_DAY,
    );

    expect(result.protected).toEqual([container]);
  });

  it("keeps recent unmanaged containers for the recovery window", () => {
    const container = candidate({ stoppedAt: "2026-07-20T11:30:00.000Z" });

    const result = classifyStoppedContainers(
      [container],
      { ids: [], appIds: [] },
      NOW,
      ONE_DAY,
    );

    expect(result.recent).toEqual([container]);
    expect(result.prunable).toEqual([]);
  });

  it("only selects an old unmanaged container for pruning", () => {
    const container = candidate();

    const result = classifyStoppedContainers(
      [container],
      { ids: [], appIds: [] },
      NOW,
      ONE_DAY,
    );

    expect(result.prunable).toEqual([container]);
    expect(result.protected).toEqual([]);
    expect(result.recent).toEqual([]);
  });

  it("fails safe when the stop timestamp is invalid", () => {
    const container = candidate({ stoppedAt: "unknown" });

    const result = classifyStoppedContainers(
      [container],
      { ids: [], appIds: [] },
      NOW,
      ONE_DAY,
    );

    expect(result.recent).toEqual([container]);
    expect(result.prunable).toEqual([]);
  });
});
