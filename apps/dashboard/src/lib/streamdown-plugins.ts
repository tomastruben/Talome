"use client";

import { useEffect, useState } from "react";
import type { PluginConfig } from "streamdown";

/**
 * On-demand Streamdown plugins.
 *
 * The plugins are heavy (mermaid, KaTeX, shiki, CJK remark plugins) and used
 * to be imported statically by every chat message renderer, which put them
 * in the first-load bundle of every dashboard page. They are now fetched the
 * first time a rendered markdown string actually needs them. Streamdown
 * renders code / mermaid fences as plain code until the plugin arrives, then
 * re-renders with highlighting or the diagram.
 */

export type StreamdownPluginName = "cjk" | "code" | "math" | "mermaid";

type LoadedPlugins = { [K in StreamdownPluginName]?: NonNullable<PluginConfig[K]> };

const PLUGIN_ORDER: readonly StreamdownPluginName[] = ["cjk", "code", "math", "mermaid"];

const loaders: { [K in StreamdownPluginName]: () => Promise<NonNullable<PluginConfig[K]>> } = {
  cjk: () => import("@streamdown/cjk").then((m) => m.cjk),
  code: () => import("@streamdown/code").then((m) => m.code),
  math: () => import("@streamdown/math").then((m) => m.math),
  // Cast: mermaid version mismatch between @streamdown/mermaid and streamdown's DiagramPlugin type.
  mermaid: () =>
    import("@streamdown/mermaid").then((m) => m.mermaid as unknown as NonNullable<PluginConfig["mermaid"]>),
};

// Any fenced code block (``` or ~~~), including one that is still streaming in.
const FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})/;
const MERMAID_FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b/i;
// @streamdown/math is configured with singleDollarTextMath=false, so only
// `$$…$$` is parsed as math.
const MATH_RE = /\$\$/;
// CJK punctuation, kana, ideographs, hangul and full-width forms.
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/** Which plugins a markdown string needs to render exactly as before. */
export function detectStreamdownPlugins(markdown: string): StreamdownPluginName[] {
  if (!markdown) return [];
  const needed: StreamdownPluginName[] = [];
  if (CJK_RE.test(markdown)) needed.push("cjk");
  if (FENCE_RE.test(markdown)) needed.push("code");
  if (MATH_RE.test(markdown)) needed.push("math");
  if (MERMAID_FENCE_RE.test(markdown)) needed.push("mermaid");
  return needed;
}

const loaded: LoadedPlugins = {};
const inflight = new Map<StreamdownPluginName, Promise<void>>();
let cachedConfigKey = "";
let cachedConfig: PluginConfig | undefined;

export function isStreamdownPluginLoaded(name: StreamdownPluginName): boolean {
  return loaded[name] !== undefined;
}

/** Load one plugin (deduped). Resolves once it is available; never rejects. */
export function loadStreamdownPlugin(name: StreamdownPluginName): Promise<void> {
  if (loaded[name]) return Promise.resolve();
  const pending = inflight.get(name);
  if (pending) return pending;
  const promise = (loaders[name]() as Promise<unknown>)
    .then((plugin) => {
      (loaded as Record<StreamdownPluginName, unknown>)[name] = plugin;
    })
    .catch(() => {
      // Chunk failed to load (offline, deploy in progress) — render without
      // the plugin and allow a later retry.
    })
    .finally(() => {
      inflight.delete(name);
    });
  inflight.set(name, promise);
  return promise;
}

/**
 * Plugin config containing every plugin loaded so far. The object identity
 * only changes when a new plugin finishes loading, so memoized renderers do
 * not re-highlight on every render.
 */
export function getLoadedStreamdownPlugins(): PluginConfig | undefined {
  const names = PLUGIN_ORDER.filter((n) => loaded[n] !== undefined);
  const key = names.join(",");
  if (key !== cachedConfigKey) {
    cachedConfigKey = key;
    cachedConfig = names.length === 0 ? undefined : { ...loaded };
  }
  return cachedConfig;
}

/** Test-only: forget loaded plugins. */
export function resetStreamdownPluginsForTests(): void {
  for (const name of PLUGIN_ORDER) delete loaded[name];
  inflight.clear();
  cachedConfigKey = "";
  cachedConfig = undefined;
}

/**
 * Returns the Streamdown `plugins` prop for `markdown`, loading any plugin the
 * content needs on first use and re-rendering once it is ready.
 */
export function useStreamdownPlugins(markdown: unknown): PluginConfig | undefined {
  const text = typeof markdown === "string" ? markdown : "";
  const neededKey = detectStreamdownPlugins(text).join(",");
  const [, setLoadedVersion] = useState(0);

  useEffect(() => {
    if (!neededKey) return;
    const missing = (neededKey.split(",") as StreamdownPluginName[]).filter((n) => !isStreamdownPluginLoaded(n));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(loadStreamdownPlugin)).then(() => {
      if (!cancelled) setLoadedVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [neededKey]);

  return getLoadedStreamdownPlugins();
}
