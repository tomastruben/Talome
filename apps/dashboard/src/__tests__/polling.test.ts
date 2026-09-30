import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  pickPollInterval,
  hasInProgressJobs,
  optimizationJobsRefreshInterval,
  useAdaptiveInterval,
  useVisibleInterval,
  POLL_FAST_MS,
  POLL_IDLE_MS,
} from "@/lib/polling";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("pickPollInterval", () => {
  it("returns the fast interval while active and the slow one while idle", () => {
    expect(pickPollInterval(true)).toBe(POLL_FAST_MS);
    expect(pickPollInterval(false)).toBe(POLL_IDLE_MS);
    expect(pickPollInterval(true, { fast: 5000, slow: 60000 })).toBe(5000);
    expect(pickPollInterval(false, { fast: 5000, slow: 60000 })).toBe(60000);
  });
});

describe("hasInProgressJobs / optimizationJobsRefreshInterval", () => {
  it("detects running or queued jobs", () => {
    expect(hasInProgressJobs(undefined)).toBe(false);
    expect(hasInProgressJobs([])).toBe(false);
    expect(hasInProgressJobs([{ status: "completed" }, { status: "failed" }])).toBe(false);
    expect(hasInProgressJobs([{ status: "completed" }, { status: "queued" }])).toBe(true);
    expect(hasInProgressJobs([{ status: "running" }])).toBe(true);
    expect(hasInProgressJobs([null, { status: null }])).toBe(false);
  });

  it("maps optimization job payloads to an interval", () => {
    expect(optimizationJobsRefreshInterval(undefined)).toBe(POLL_IDLE_MS);
    expect(optimizationJobsRefreshInterval({ jobs: [{ status: "completed" }] })).toBe(POLL_IDLE_MS);
    expect(optimizationJobsRefreshInterval({ jobs: [{ status: "running" }] })).toBe(POLL_FAST_MS);
    expect(optimizationJobsRefreshInterval({ jobs: [{ status: "running" }] }, { fast: 5000 })).toBe(5000);
  });
});

describe("useAdaptiveInterval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("follows the active flag without a grace window", () => {
    const { result, rerender } = renderHook(({ active }) => useAdaptiveInterval(active, { fast: 1000, slow: 9000 }), {
      initialProps: { active: false },
    });
    expect(result.current).toBe(9000);
    rerender({ active: true });
    expect(result.current).toBe(1000);
    rerender({ active: false });
    expect(result.current).toBe(9000);
  });

  it("keeps the fast interval for the grace window after activity ends", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useAdaptiveInterval(active, { fast: 1000, slow: 9000, graceMs: 5000 }),
      { initialProps: { active: true } },
    );
    expect(result.current).toBe(1000);
    rerender({ active: false });
    expect(result.current).toBe(1000);
    act(() => { vi.advanceTimersByTime(4999); });
    expect(result.current).toBe(1000);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(9000);
  });

  it("does not start a grace window when it was never active", () => {
    const { result } = renderHook(() => useAdaptiveInterval(false, { fast: 1000, slow: 9000, graceMs: 5000 }));
    expect(result.current).toBe(9000);
  });
});

describe("useVisibleInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("ticks while visible and is cleared on unmount", () => {
    const cb = vi.fn();
    const { unmount } = renderHook(() => useVisibleInterval(cb, 1000));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(cb).toHaveBeenCalledTimes(3);
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("pauses while the tab is hidden and catches up once when visible again", () => {
    const cb = vi.fn();
    renderHook(() => useVisibleInterval(cb, 1000));
    act(() => { setVisibility("hidden"); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(cb).toHaveBeenCalledTimes(0);
    act(() => { setVisibility("visible"); });
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("runs immediately when requested and stops when the delay is null", () => {
    const cb = vi.fn();
    const { rerender } = renderHook(({ delay }) => useVisibleInterval(cb, delay, { immediate: true }), {
      initialProps: { delay: 1000 as number | null },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    rerender({ delay: null });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("always calls the latest callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useVisibleInterval(cb, 1000), { initialProps: { cb: first } });
    rerender({ cb: second });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
