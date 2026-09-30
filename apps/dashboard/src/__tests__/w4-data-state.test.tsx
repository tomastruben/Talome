import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, renderHook, act } from "@testing-library/react";
import { StaleRow, staleMessage, useLoadingPhase } from "@/components/data-state/data-state";

afterEach(() => {
  vi.useRealTimers();
});

describe("useLoadingPhase", () => {
  it("shows nothing for a fast load, never a skeleton flash", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ loading }) => useLoadingPhase(loading), { initialProps: { loading: true } });
    expect(result.current).toBe("wait");
    act(() => vi.advanceTimersByTime(150));
    rerender({ loading: false });
    expect(result.current).toBe("ready");
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe("ready");
  });

  it("shows the skeleton after 200ms and keeps it at least 300ms", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ loading }) => useLoadingPhase(loading), { initialProps: { loading: true } });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe("skeleton");
    act(() => vi.advanceTimersByTime(50));
    rerender({ loading: false });
    expect(result.current).toBe("skeleton");
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe("ready");
  });

  it("is ready at once when nothing is loading", () => {
    const { result } = renderHook(() => useLoadingPhase(false));
    expect(result.current).toBe("ready");
  });
});

describe("StaleRow", () => {
  it("says the data may be old and offers Retry", () => {
    const onRetry = vi.fn();
    render(<StaleRow loadedAt={Date.now() - 3 * 60_000} subject="files" onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't refresh · showing files from 3 min ago");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("never invents a time it doesn't know", () => {
    expect(staleMessage(null)).toBe("Couldn't refresh · showing the last data Talome loaded");
  });
});
