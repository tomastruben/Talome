import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("@streamdown/cjk", () => ({ cjk: { name: "cjk", type: "cjk" } }));
vi.mock("@streamdown/code", () => ({ code: { name: "shiki", type: "code-highlighter" } }));
vi.mock("@streamdown/math", () => ({ math: { name: "katex", type: "math" } }));
vi.mock("@streamdown/mermaid", () => ({ mermaid: { name: "mermaid", type: "diagram" } }));

import {
  detectStreamdownPlugins,
  getLoadedStreamdownPlugins,
  isStreamdownPluginLoaded,
  loadStreamdownPlugin,
  resetStreamdownPluginsForTests,
  useStreamdownPlugins,
} from "@/lib/streamdown-plugins";

describe("detectStreamdownPlugins", () => {
  it("needs nothing for plain prose", () => {
    expect(detectStreamdownPlugins("")).toEqual([]);
    expect(detectStreamdownPlugins("Plex is **running** on port 32400. Use `docker ps`.")).toEqual([]);
    // single-dollar math is disabled in the math plugin config
    expect(detectStreamdownPlugins("It costs $5 and $10")).toEqual([]);
  });

  it("detects fenced code, including a fence that is still streaming", () => {
    expect(detectStreamdownPlugins("Run this:\n```bash\nls\n```")).toEqual(["code"]);
    expect(detectStreamdownPlugins("```ts\nconst a")).toEqual(["code"]);
    expect(detectStreamdownPlugins("~~~\nplain\n~~~")).toEqual(["code"]);
  });

  it("detects mermaid fences (which also need the code plugin)", () => {
    expect(detectStreamdownPlugins("```mermaid\ngraph TD; A-->B\n```")).toEqual(["code", "mermaid"]);
  });

  it("detects display math and CJK text", () => {
    expect(detectStreamdownPlugins("$$E = mc^2$$")).toEqual(["math"]);
    expect(detectStreamdownPlugins("映画を見る")).toEqual(["cjk"]);
    expect(detectStreamdownPlugins("한국어")).toEqual(["cjk"]);
  });
});

describe("plugin loading", () => {
  beforeEach(() => {
    resetStreamdownPluginsForTests();
  });

  it("loads a plugin once and exposes a stable config object", async () => {
    expect(getLoadedStreamdownPlugins()).toBeUndefined();
    await Promise.all([loadStreamdownPlugin("code"), loadStreamdownPlugin("code")]);
    expect(isStreamdownPluginLoaded("code")).toBe(true);
    const first = getLoadedStreamdownPlugins();
    expect(first?.code).toBeDefined();
    expect(first?.mermaid).toBeUndefined();
    expect(getLoadedStreamdownPlugins()).toBe(first);
    await loadStreamdownPlugin("math");
    const second = getLoadedStreamdownPlugins();
    expect(second).not.toBe(first);
    expect(second?.math).toBeDefined();
  });

  it("useStreamdownPlugins loads only what the content needs", async () => {
    const { result, rerender } = renderHook(({ md }) => useStreamdownPlugins(md), {
      initialProps: { md: "Just text" as unknown },
    });
    expect(result.current).toBeUndefined();

    rerender({ md: "```mermaid\ngraph TD\n```" });
    await waitFor(() => expect(result.current?.mermaid).toBeDefined());
    expect(result.current?.code).toBeDefined();
    expect(result.current?.math).toBeUndefined();
    expect(result.current?.cjk).toBeUndefined();
    expect(isStreamdownPluginLoaded("math")).toBe(false);
  });

  it("ignores non-string children", () => {
    const { result } = renderHook(() => useStreamdownPlugins(undefined));
    expect(result.current).toBeUndefined();
  });
});
