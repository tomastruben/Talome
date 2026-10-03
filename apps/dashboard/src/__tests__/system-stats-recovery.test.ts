import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemStatsStore } from "@/hooks/use-system-stats";

class Stream {
  static instances: Stream[] = [];
  handlers = new Map<string, (event: { data: string }) => void>();
  close = vi.fn();
  constructor() { Stream.instances.push(this); }
  addEventListener(name: string, handler: (event: { data: string }) => void) {
    this.handlers.set(name, handler);
  }
  stats(usage: number) { this.handlers.get("stats")?.({ data: JSON.stringify(stats(usage)) }); }
  error() { this.handlers.get("error")?.({ data: "" }); }
}
const stats = (usage: number) => ({
  cpu: { usage }, memory: { percent: 60 }, disk: { percent: 80 },
  network: { rxBytesPerSec: 1024, txBytesPerSec: 2048 },
});
let fetchStats: ReturnType<typeof vi.fn>;
let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Stream.instances = [];
  vi.stubGlobal("EventSource", Stream);
  fetchStats = vi.fn(async () => new Response(JSON.stringify(stats(12))));
  vi.stubGlobal("fetch", fetchStats);
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("stats stream recovery", () => {
  it("replaces a stalled first connection with authenticated same-origin polling and retries streaming", async () => {
    const store = createSystemStatsStore();
    unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(8000);
    expect(Stream.instances[0].close).toHaveBeenCalled();
    expect(fetchStats).toHaveBeenCalledWith("/api/system", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(store.getSnapshot().stats?.cpu.usage).toBe(12);
    expect(store.getSnapshot().error).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(Stream.instances).toHaveLength(2);
    Stream.instances[1].stats(28);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchStats).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().stats?.cpu.usage).toBe(28);
  });

  it("detects a silent stall after receiving data and ignores events from closed streams", async () => {
    const store = createSystemStatsStore();
    unsubscribe = store.subscribe(() => {});
    Stream.instances[0].stats(4);
    await vi.advanceTimersByTimeAsync(15000);
    expect(store.getSnapshot().stats?.cpu.usage).toBe(12);
    Stream.instances[0].stats(99);
    expect(store.getSnapshot().stats?.cpu.usage).toBe(12);
  });

  it("aborts pending fallback and prevents late writes or reconnects after unsubscribe", async () => {
    let resolve!: (response: Response) => void;
    fetchStats.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const store = createSystemStatsStore();
    unsubscribe = store.subscribe(() => {});
    Stream.instances[0].error();
    const signal = fetchStats.mock.calls[0][1].signal as AbortSignal;
    unsubscribe();
    unsubscribe = undefined;
    expect(signal.aborted).toBe(true);
    resolve(new Response(JSON.stringify(stats(50))));
    await vi.advanceTimersByTimeAsync(30000);
    expect(store.getSnapshot().stats).toBeNull();
    expect(Stream.instances).toHaveLength(1);
    expect(fetchStats).toHaveBeenCalledTimes(1);
  });

  it("shows an error only when fallback also fails, then clears it when requests recover", async () => {
    fetchStats.mockRejectedValueOnce(new Error("Offline"));
    const store = createSystemStatsStore();
    unsubscribe = store.subscribe(() => {});
    Stream.instances[0].error();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().error).toContain("Retrying automatically");
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getSnapshot().stats?.cpu.usage).toBe(12);
    expect(store.getSnapshot().error).toBeNull();
  });
});
