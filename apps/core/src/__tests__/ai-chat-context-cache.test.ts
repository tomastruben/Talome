import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fingerprintRow, getTopMemoriesMock, getFeatureStackStatusMock } = vi.hoisted(() => ({
  fingerprintRow: { current: { n: 2, maxId: 2, maxUpdated: "2026-01-01T00:00:00.000Z" } as Record<string, unknown> },
  getTopMemoriesMock: vi.fn(),
  getFeatureStackStatusMock: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ get: () => fingerprintRow.current }),
      }),
    }),
  },
  schema: { memories: { id: "id", updatedAt: "updated_at", enabled: "enabled" } },
}));
vi.mock("../db/memories.js", () => ({ getTopMemories: getTopMemoriesMock }));
vi.mock("../stacks/feature-stacks.js", () => ({ getFeatureStackStatus: getFeatureStackStatusMock }));

import {
  FEATURE_STACK_TTL_MS,
  MEMORIES_TTL_MS,
  getCachedFeatureStackStatus,
  getCachedTopMemories,
  invalidateChatContextCaches,
} from "../ai/chat-context-cache.js";

beforeEach(() => {
  vi.useFakeTimers();
  invalidateChatContextCaches();
  getTopMemoriesMock.mockReset();
  getFeatureStackStatusMock.mockReset();
  fingerprintRow.current = { n: 2, maxId: 2, maxUpdated: "2026-01-01T00:00:00.000Z" };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("feature-stack status cache", () => {
  it("reuses the result within the TTL and refreshes after it", async () => {
    getFeatureStackStatusMock.mockResolvedValueOnce([{ id: "a" }]).mockResolvedValueOnce([{ id: "b" }]);
    expect(await getCachedFeatureStackStatus()).toEqual([{ id: "a" }]);
    vi.advanceTimersByTime(FEATURE_STACK_TTL_MS - 1000);
    expect(await getCachedFeatureStackStatus()).toEqual([{ id: "a" }]);
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(await getCachedFeatureStackStatus()).toEqual([{ id: "b" }]);
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh between concurrent callers", async () => {
    getFeatureStackStatusMock.mockResolvedValue([]);
    await Promise.all([getCachedFeatureStackStatus(), getCachedFeatureStackStatus(), getCachedFeatureStackStatus()]);
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(1);
  });
});

describe("top memories cache", () => {
  const memories = [
    { id: 5, content: "likes 4K" },
    { id: 2, content: "media on /mnt/media" },
  ];

  it("caches within the TTL, sorted by id", async () => {
    getTopMemoriesMock.mockResolvedValue(memories);
    const first = await getCachedTopMemories(10);
    expect(first.map((m) => m.id)).toEqual([2, 5]);
    vi.advanceTimersByTime(MEMORIES_TTL_MS - 1000);
    await getCachedTopMemories(10);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await getCachedTopMemories(10);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(2);
  });

  it("reloads as soon as the memories table changes", async () => {
    getTopMemoriesMock.mockResolvedValue(memories);
    await getCachedTopMemories(10);
    fingerprintRow.current = { n: 3, maxId: 7, maxUpdated: "2026-01-02T00:00:00.000Z" };
    await getCachedTopMemories(10);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache when the change detector is unavailable", async () => {
    getTopMemoriesMock.mockResolvedValue(memories);
    fingerprintRow.current = undefined as unknown as Record<string, unknown>;
    await getCachedTopMemories(10);
    await getCachedTopMemories(10);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(2);
  });
});
