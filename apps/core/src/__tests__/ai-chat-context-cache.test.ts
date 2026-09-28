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
  getConversationMemories,
  getTurnNotes,
  invalidateChatContextCaches,
  invalidateConversationMemories,
  invalidateFeatureStackCache,
  rememberTurnNote,
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

  it("refreshes right after an invalidation, within the TTL", async () => {
    getFeatureStackStatusMock.mockResolvedValueOnce([{ id: "before-install" }]).mockResolvedValueOnce([{ id: "after-install" }]);
    expect(await getCachedFeatureStackStatus()).toEqual([{ id: "before-install" }]);
    invalidateFeatureStackCache();
    expect(await getCachedFeatureStackStatus()).toEqual([{ id: "after-install" }]);
  });

  it("does not let a refresh started before an invalidation populate the cache or clear a newer refresh", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    let resolveNew: (v: unknown) => void = () => {};
    getFeatureStackStatusMock
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveNew = r; }))
      .mockResolvedValue([{ id: "unexpected" }]);

    const oldCall = getCachedFeatureStackStatus();
    invalidateFeatureStackCache();
    const newCall = getCachedFeatureStackStatus();

    resolveOld([{ id: "stale" }]);
    await oldCall;
    // The newer refresh is still the shared in-flight one.
    const joined = getCachedFeatureStackStatus();
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(2);

    resolveNew([{ id: "fresh" }]);
    expect(await newCall).toEqual([{ id: "fresh" }]);
    expect(await joined).toEqual([{ id: "fresh" }]);
    expect(await getCachedFeatureStackStatus()).toEqual([{ id: "fresh" }]);
    expect(getFeatureStackStatusMock).toHaveBeenCalledTimes(2);
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

  it("reloads when a memory is written while the list is loading", async () => {
    getTopMemoriesMock.mockImplementationOnce(async () => {
      // Memory extraction inserts a row while getTopMemories runs.
      fingerprintRow.current = { n: 3, maxId: 9, maxUpdated: "2026-01-03T00:00:00.000Z" };
      return memories;
    });
    getTopMemoriesMock.mockResolvedValue([...memories, { id: 9, content: "new" }]);
    await getCachedTopMemories(10);
    const second = await getCachedTopMemories(10);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(2);
    expect(second.map((m) => m.id)).toEqual([2, 5, 9]);
  });

  it("does not cache when the change detector is unavailable", async () => {
    getTopMemoriesMock.mockResolvedValue(memories);
    fingerprintRow.current = undefined as unknown as Record<string, unknown>;
    await getCachedTopMemories(10);
    await getCachedTopMemories(10);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(2);
  });
});

describe("per-conversation context", () => {
  it("snapshots memories per conversation so new memories do not change a running conversation", async () => {
    getTopMemoriesMock.mockResolvedValueOnce([{ id: 1, content: "a" }]).mockResolvedValue([{ id: 1, content: "a" }, { id: 2, content: "b" }]);
    expect((await getConversationMemories("conv-1")).map((m) => m.id)).toEqual([1]);
    fingerprintRow.current = { n: 3, maxId: 2, maxUpdated: "2026-01-02T00:00:00.000Z" };
    expect((await getConversationMemories("conv-1")).map((m) => m.id)).toEqual([1]);
    // A new conversation sees the new memory.
    expect((await getConversationMemories("conv-2")).map((m) => m.id)).toEqual([1, 2]);
    // After an explicit invalidation the conversation reloads.
    invalidateConversationMemories("conv-1");
    expect((await getConversationMemories("conv-1")).map((m) => m.id)).toEqual([1, 2]);
  });

  it("falls back to the global cache without a conversation key", async () => {
    getTopMemoriesMock.mockResolvedValue([{ id: 1, content: "a" }]);
    await getConversationMemories(undefined);
    await getConversationMemories(undefined);
    expect(getTopMemoriesMock).toHaveBeenCalledTimes(1);
  });

  it("remembers turn notes per conversation and message", () => {
    rememberTurnNote("conv-1", "u1", "page: /apps");
    rememberTurnNote("conv-1", "u2", "page: /media");
    rememberTurnNote(undefined, "u3", "ignored");
    expect([...getTurnNotes("conv-1").entries()]).toEqual([["u1", "page: /apps"], ["u2", "page: /media"]]);
    expect(getTurnNotes("conv-2").size).toBe(0);
    expect(getTurnNotes(undefined).size).toBe(0);
  });
});
