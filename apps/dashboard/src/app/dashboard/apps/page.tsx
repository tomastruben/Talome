"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { motion } from "framer-motion";
import { SearchField } from "@/components/ui/search-field";
import {
  HugeiconsIcon,
  CheckmarkCircle01Icon,
} from "@/components/icons";
import { Tabs, TabsList, TabsTrigger, TabsBadge } from "@/components/ui/tabs";
import { AppCard } from "@/components/dashboard/app-card";
import { StackCard } from "@/components/dashboard/stack-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { CORE_URL } from "@/lib/constants";
import { installedAppsRefreshInterval, installedStateSignature } from "@/lib/polling";
import type { CatalogApp, StoreSource, StackListItem } from "@talome/types";

type Tab = "all" | "installed" | string;

const PAGE_CHUNK = 60;
/** Don't refetch the multi-MB catalog more than once per this window. */
const CATALOG_DEDUPE_MS = 5 * 60 * 1000;

function sourceLabel(type: string) {
  if (type === "casaos") return "CasaOS";
  if (type === "umbrel") return "Umbrel";
  if (type === "user-created") return "My Apps";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function useAutoLoadSentinel({
  targetRef,
  enabled,
  onLoadMore,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onLoadMore: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const target = targetRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      { rootMargin: "600px 0px 400px 0px", threshold: 0.01 },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, onLoadMore, targetRef]);
}

export default function AppsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center p-12"><Spinner /></div>}>
      <AppsPageContent />
    </Suspense>
  );
}

function AppsPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [sourceCache, setSourceCache] = useState<Record<string, CatalogApp[]>>({});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [tab, setTab] = useState<Tab>(searchParams.get("tab") || "all");
  const [hoveredStackIndex, setHoveredStackIndex] = useState<number | null>(null);
  // Paging is keyed by the active filters so a filter change resets the visible
  // window during render instead of via a setState-in-effect round trip.
  const filterKey = `${tab}\u0000${category}\u0000${search}`;
  const [paging, setPaging] = useState({ key: filterKey, count: PAGE_CHUNK });
  const visibleCount = paging.key === filterKey ? paging.count : PAGE_CHUNK;
  const loadSentinelRef = useRef<HTMLDivElement | null>(null);

  const changeTab = useCallback((newTab: string) => {
    setTab(newTab);
    setCategory("all");
    const params = new URLSearchParams(window.location.search);
    if (newTab === "all") {
      params.delete("tab");
    } else {
      params.set("tab", newTab);
    }
    const qs = params.toString();
    router.replace(`/dashboard/apps${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [router]);

  const jsonFetcher = useCallback((url: string) => fetch(url).then((r) => r.ok ? r.json() : Promise.reject(new Error("fetch failed"))), []);
  const swrOpts = { revalidateOnFocus: true, revalidateOnReconnect: true, keepPreviousData: true } as const;

  // The full catalog is several MB and changes rarely — don't refetch it on
  // every window focus or remount within a few minutes (explicit retries and
  // mutations still refresh it).
  const { data: catalogData, mutate: mutateApps, error: appsError } = useSWR<CatalogApp[]>(
    `${CORE_URL}/api/apps?limit=2000`, jsonFetcher,
    { ...swrOpts, revalidateOnFocus: false, dedupingInterval: CATALOG_DEDUPE_MS },
  );
  // Installed tab: poll fast only while an install/update is in progress.
  const { data: installedData, mutate: mutateInstalled } = useSWR<CatalogApp[]>(
    `${CORE_URL}/api/apps/installed`, jsonFetcher,
    {
      ...swrOpts,
      refreshInterval: tab === "installed" ? installedAppsRefreshInterval : 0,
    },
  );
  // The catalog is cached for minutes, but its `installed` badges must not go
  // stale: the small installed-apps list revalidates on every mount/focus, so
  // when it disagrees with the cached catalog (install, uninstall, start/stop
  // from the detail page or the assistant), refetch the catalog once.
  const catalogIds = useMemo(
    () => (catalogData ? new Set(catalogData.map((a) => a.id)) : null),
    [catalogData],
  );
  const catalogInstalledSig = useMemo(
    () => (catalogData ? installedStateSignature(catalogData) : null),
    [catalogData],
  );
  const installedListSig = useMemo(
    () => (installedData && catalogIds ? installedStateSignature(installedData, catalogIds) : null),
    [installedData, catalogIds],
  );
  useEffect(() => {
    if (catalogInstalledSig === null || installedListSig === null) return;
    if (catalogInstalledSig !== installedListSig) void mutateApps();
  }, [catalogInstalledSig, installedListSig, mutateApps]);
  const { data: stores = [] } = useSWR<StoreSource[]>(
    `${CORE_URL}/api/stores`, jsonFetcher, swrOpts,
  );
  const { data: categories = [] } = useSWR<string[]>(
    `${CORE_URL}/api/apps/categories`, jsonFetcher, swrOpts,
  );
  const { data: stacksData } = useSWR<{ stacks: StackListItem[] }>(
    `${CORE_URL}/api/stacks`, jsonFetcher, swrOpts,
  );
  const { data: updatesData = [] } = useSWR<{ appId: string; hasUpdate: boolean }[]>(
    `${CORE_URL}/api/updates`, jsonFetcher, { ...swrOpts, refreshInterval: 5 * 60 * 1000 },
  );
  const apps = useMemo(() => catalogData ?? [], [catalogData]);
  const installedApps = useMemo(() => installedData ?? [], [installedData]);
  const stacks = stacksData?.stacks ?? [];
  const appsWithUpdates = useMemo(
    () => new Set(updatesData.filter((u) => u.hasUpdate).map((u) => u.appId)),
    [updatesData],
  );
  const loading = !apps.length && !appsError;
  const fetchError = appsError && !apps.length ? "Failed to load apps. Check that the Talome server is running." : null;

  const fetchData = useCallback(() => {
    void mutateApps();
    void mutateInstalled();
  }, [mutateApps, mutateInstalled]);

  useEffect(() => {
    if (tab === "all" || tab === "installed") return;
    if (sourceCache[tab]) return;

    let cancelled = false;
    fetch(`${CORE_URL}/api/apps?limit=2000&source=${encodeURIComponent(tab)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load source apps");
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSourceCache((prev) => ({ ...prev, [tab]: Array.isArray(data) ? data : [] }));
      })
      .catch(() => {
        if (cancelled) return;
        setSourceCache((prev) => ({ ...prev, [tab]: [] }));
      });

    return () => {
      cancelled = true;
    };
  }, [tab, sourceCache]);

  const SOURCE_TAB_ORDER: Record<string, number> = { umbrel: 0, talome: 1, casaos: 2, "user-created": 3 };
  const sourceTypes = useMemo(
    () => [...new Set(stores.map((s) => s.type))].sort(
      (a, b) => (SOURCE_TAB_ORDER[a] ?? 9) - (SOURCE_TAB_ORDER[b] ?? 9),
    ),
    [stores],
  );

  const handleDeleteUserApp = useCallback(async (appId: string) => {
    try {
      const res = await fetch(`${CORE_URL}/api/user-apps/${appId}`, { method: "DELETE" });
      if (!res.ok) return;
      setSourceCache((prev) => {
        const cached = prev["user-created"];
        if (!cached) return prev;
        return { ...prev, "user-created": cached.filter((a) => a.id !== appId) };
      });
      void mutateApps((prev) => prev?.filter((a) => !(a.id === appId && a.storeId === "user-apps")), false);
    } catch { /* ignore */ }
  }, [mutateApps]);

  const isInstalled = tab === "installed";
  const currentApps = isInstalled ? installedApps : tab === "all" ? apps : (sourceCache[tab] || []);

  const filtered = useMemo(() => {
    return currentApps.filter((app) => {
      const q = search.toLowerCase();
      const matchesSearch =
        !search ||
        app.name.toLowerCase().includes(q) ||
        app.tagline?.toLowerCase().includes(q) ||
        app.description?.toLowerCase().includes(q);
      const matchesCategory = category === "all" || app.category === category;
      return matchesSearch && matchesCategory;
    });
  }, [currentApps, search, category]);

  const loadNextChunk = useCallback(() => {
    setPaging((prev) => {
      const current = prev.key === filterKey ? prev.count : PAGE_CHUNK;
      return { key: filterKey, count: Math.min(current + PAGE_CHUNK, filtered.length) };
    });
  }, [filterKey, filtered.length]);

  useAutoLoadSentinel({
    targetRef: loadSentinelRef,
    enabled: !loading && filtered.length > visibleCount,
    onLoadMore: loadNextChunk,
  });

  const visibleApps = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;

  const totalInstalled = installedApps.length;
  const hasSourceCache = tab === "all" || tab === "installed" || !!sourceCache[tab];
  // The source-tab fetch is in flight exactly while that tab has no cached result.
  const showSourceLoading = !isInstalled && !loading && !hasSourceCache;
  const leftFadeOpacity = hoveredStackIndex === 0 ? 0 : hoveredStackIndex === null ? 1 : 0.72;
  const rightFadeOpacity = hoveredStackIndex === stacks.length - 1 ? 0 : hoveredStackIndex === null ? 1 : 0.72;

  return (
    <div className="min-w-0 grid gap-5">
      {/* ── Tabs + search ──────────────────────────────── */}
      <div className="page-controls-row flex-wrap justify-between gap-2">
        <Tabs value={tab} onValueChange={changeTab}>
          <TabsList>
            <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
            {sourceTypes.map((t) => (
              t === "user-created" ? (
                <TabsTrigger key={t} value={t} className="text-xs" aria-label="My Apps" title="My Apps">
                  My Apps
                </TabsTrigger>
              ) : (
                <TabsTrigger key={t} value={t} className="text-xs">
                  {sourceLabel(t)}
                </TabsTrigger>
              )
            ))}
            <TabsTrigger value="installed" className="text-xs px-2" aria-label="Installed" title="Installed">
              <HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} />
              {totalInstalled > 0 && <TabsBadge>{totalInstalled}</TabsBadge>}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end sm:gap-2">
          <SearchField
            containerClassName="flex-1 w-full sm:w-auto"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* ── Category pills — "all" pinned, rest scroll ── */}
      {!isInstalled && tab !== "user-created" && categories.length > 0 && (
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            className={`h-6 px-2 rounded-full border text-xs transition-colors shrink-0 ${
              category === "all"
                ? "border-foreground/30 bg-foreground/8 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setCategory("all")}
          >
            all
          </button>
          <div className="filter-rail min-w-0 flex-1">
            <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none">
              {categories.map((cat) => (
                <button
                  key={cat}
                  className={`h-6 px-2 rounded-full border text-xs transition-colors shrink-0 ${
                    category === cat
                      ? "border-foreground/30 bg-foreground/8 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Featured stacks ─────────────────────────────── */}
      {tab === "all" && !search && category === "all" && stacks.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Stacks</h2>
          <div className="stacks-scroll-rail -mt-2 -mb-2">
            <motion.div
              className="pointer-events-none absolute inset-y-0 left-0 z-10 w-[18px] bg-gradient-to-r from-background to-transparent"
              animate={{ opacity: leftFadeOpacity }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            />
            <motion.div
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-[18px] bg-gradient-to-l from-background to-transparent"
              animate={{ opacity: rightFadeOpacity }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            />
            <div className="flex items-stretch gap-4 overflow-x-auto py-2 pr-1 pl-0.5 scrollbar-none">
              {stacks.map((s, index) => (
                <div
                  key={s.id}
                  className="shrink-0 h-full"
                  onMouseEnter={() => setHoveredStackIndex(index)}
                  onMouseLeave={() => setHoveredStackIndex(null)}
                >
                  <StackCard stack={s} />
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Results ─────────────────────────────────────── */}
      {loading || showSourceLoading ? (
        <div className="app-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-[248px] rounded-xl" />
          ))}
        </div>
      ) : fetchError ? (
        <ErrorState
          title="Couldn't load App Store"
          description={fetchError}
          onRetry={fetchData}
        />
      ) : filtered.length === 0 ? (
        tab === "user-created" ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-24 gap-5">
            <div className="flex flex-col items-center gap-2">
              <span className="text-2xl">+</span>
              <p className="text-sm text-muted-foreground">No apps yet</p>
            </div>
            <p className="text-xs text-muted-foreground max-w-xs text-center leading-relaxed">
              Describe what you want to run and Claude Code will build it for you.
            </p>
            <Link
              href="/dashboard/assistant?prompt=I+want+to+create+a+new+app"
              className="text-sm font-medium text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground transition-colors"
            >
              Create your first app
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-24 gap-3">
            <p className="text-sm text-muted-foreground">
              {isInstalled ? "No apps installed yet" : "No apps found"}
            </p>
            {isInstalled ? (
              <button
                className="text-sm font-medium text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground transition-colors"
                onClick={() => changeTab("all")}
              >
                Browse the store
              </button>
            ) : search ? (
              <Link
                href={`/dashboard/assistant?prompt=${encodeURIComponent(`Create an app: ${search}`)}`}
                className="text-sm font-medium text-foreground underline underline-offset-4 decoration-muted-foreground/40 hover:decoration-foreground transition-colors"
              >
                Create &ldquo;{search}&rdquo; with AI
              </Link>
            ) : null}
          </div>
        )
      ) : (
        <>
          {search && (
            <p className="text-xs text-muted-foreground -mt-4">
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            </p>
          )}
          <div className="app-grid">
            {visibleApps.map((app, i) => (
              <AppCard
                key={`${app.storeId}-${app.id}`}
                app={app}
                priority={i < 12}
                eager={i < PAGE_CHUNK}
                onDelete={tab === "user-created" ? handleDeleteUserApp : undefined}
                hasUpdate={appsWithUpdates.has(app.id)}
              />
            ))}
            {search && !isInstalled && filtered.length < 3 && (
              <Link
                href={`/dashboard/assistant?prompt=${encodeURIComponent(`Create an app: ${search}`)}`}
                className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 p-6 text-center hover:border-foreground/20 hover:bg-muted/30 transition-colors min-h-[248px]"
              >
                <span className="text-2xl">✨</span>
                <span className="text-sm font-medium">
                  Create &ldquo;{search}&rdquo;
                </span>
                <span className="text-xs text-muted-foreground">
                  Generate a custom app with AI
                </span>
              </Link>
            )}
          </div>
          {hasMore && (
            <div ref={loadSentinelRef} className="flex justify-center py-2">
              <span className="text-xs text-muted-foreground">Loading more apps...</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
