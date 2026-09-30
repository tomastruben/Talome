import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBlueprintBuild } from "@/hooks/use-blueprint-build";
import type { BlueprintState } from "@/components/creator/blueprint-draft-bar";
const blueprint: BlueprintState = { identity: { name: "Chart Studio", description: "Analyze sensors" } };
const draft = { ok: true, draft: { app: { id: "chart-studio" }, workspace: { rootPath: "/private/chart-studio" }, taskPrompt: "Build the reviewed app" } };
const session = { sessionName: "creator-chart", command: "claude", workspaceRoot: "/private/chart-studio" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("blueprint build handoff", () => {
  it("prepares privately, preserves the blueprint on execution refusal, and retries the same workspace", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(draft)).mockResolvedValueOnce(json({ error: "Claude CLI is unavailable" }, 503)).mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetch); const onSession = vi.fn();
    const { result } = renderHook(() => useBlueprintBuild(blueprint, false, onSession));
    await act(() => result.current.build());
    expect(result.current.error).toBe("Claude CLI is unavailable");
    expect(result.current.building).toBe(false); expect(onSession).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ saveImmediately: false, preBuiltBlueprint: blueprint });
    await act(() => result.current.build());
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/apps/create", "/api/apps/create/execute", "/api/apps/create/execute"]);
    expect(onSession).toHaveBeenCalledWith({ ...session, appId: "chart-studio", taskPrompt: "Build the reviewed app" });
    expect(result.current.error).toBeNull(); expect(blueprint.identity?.name).toBe("Chart Studio");
  });
  it("surfaces preparation failure without trying execution or any assistant request", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: "Blueprint needs research" }, 422));vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useBlueprintBuild(blueprint, false, vi.fn()));
    await act(() => result.current.build());
    expect(result.current.error).toBe("Blueprint needs research");expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a missing workspace and prepares anew after the blueprint changes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json(draft)).mockResolvedValueOnce(json(session));vi.stubGlobal("fetch", fetch);
    const { result, rerender } = renderHook(({ current }) => useBlueprintBuild(current, true, vi.fn()), { initialProps: { current: blueprint } });
    await act(() => result.current.build());expect(result.current.error).toMatch(/workspace/);
    rerender({ current: { identity: { name: "Updated Studio" } } });expect(result.current.error).toBeNull();
    await act(() => result.current.build());expect(JSON.parse(fetch.mock.calls[1][1].body).preBuiltBlueprint.identity.name).toBe("Updated Studio");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("blueprint build conversation lifecycle", () => {
  it("does not start execution when a prepared draft arrives after switching conversations", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetch); const onSession = vi.fn();
    const { result, rerender } = renderHook(({ conversationId }) => useBlueprintBuild(blueprint, false, onSession, conversationId), { initialProps: { conversationId: "first" } });
    let build!: Promise<void>;
    act(() => { build = result.current.build(); });
    rerender({ conversationId: "second" });
    expect(result.current.building).toBe(false);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(json(draft)); await build; });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onSession).not.toHaveBeenCalled(); expect(result.current.error).toBeNull();
  });

  it.each([200, 503])("discards a stale execution response (%i) without affecting the next build", async (status) => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json(draft)).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(json(draft)).mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetch); const onSession = vi.fn();
    const { result, rerender } = renderHook(({ conversationId }) => useBlueprintBuild(blueprint, false, onSession, conversationId), { initialProps: { conversationId: "first" } });
    let build!: Promise<void>;
    await act(async () => { build = result.current.build(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    rerender({ conversationId: "second" });
    await act(() => result.current.build());
    expect(onSession).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(json(status === 200 ? session : { error: "Old failure" }, status)); await build; });
    expect(onSession).toHaveBeenCalledTimes(1); expect(result.current.error).toBeNull();
    expect(result.current.building).toBe(false);
    expect(fetch.mock.calls.filter(call => call[0] === "/api/apps/create")).toHaveLength(2);
  });

  it("discards preparation after unmount without starting a server execution", async () => {
    const pending = deferred<Response>(); const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetch); const onSession = vi.fn();
    const { result, unmount } = renderHook(() => useBlueprintBuild(blueprint, false, onSession));
    let build!: Promise<void>;act(() => { build = result.current.build(); });unmount();
    await act(async () => { pending.resolve(json(draft)); await build; });
    expect(fetch).toHaveBeenCalledTimes(1); expect(onSession).not.toHaveBeenCalled();
  });
});
