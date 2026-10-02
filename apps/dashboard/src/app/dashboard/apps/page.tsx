"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { SearchField } from "@/components/ui/search-field";
import {
  HugeiconsIcon,
  Add01Icon,
  CheckmarkCircle01Icon,
  AiMagicIcon,
  Package01Icon,
  Globe02Icon,
  LayoutGridIcon,
  Package02Icon,
  PackageOpenIcon,
} from "@/components/icons";
import {
  SourceList,
  SourceListItem,
  SourceListSection,
  WINDOW_SIDEBAR_REPLACES,
  WindowSidebarLayout,
} from "@/components/ui/source-list";
import { Tabs, TabsList, TabsTrigger, TabsBadge } from "@/components/ui/tabs";
import { AppCard } from "@/components/dashboard/app-card";
import { StackCard } from "@/components/dashboard/stack-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { StaleRow, useLoadedAt, useLoadingPhase } from "@/components/data-state/data-state";
import { fetchJson } from "@/lib/fetch-json";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { CORE_URL } from "@/lib/constants";
import { deleteCreatedAppCopy, emptyCatalogCopy } from "@/lib/app-store-copy";
import { Button } from "@/components/ui/button";
import { installedAppsRefreshInterval, installedStateSignature } from "@/lib/polling";
import { cn } from "@/lib/utils";
import { appStoreViewTitle, categoryLabel, sourceLabel } from "./_lib/app-store-view";
import type { CatalogApp, StoreSource, StackListItem } from "@talome/types";

type Tab = "all" | "installed" | string;

const PAGE_CHUNK = 60;
const SOURCE_TAB_ORDER: Record<string, number> = {
  umbrel: 0,
  talome: 1,
  casaos: 2,
  "user-created": 3,
};
/** Don't refetch the multi-MB catalog more than once per this window. */
const CATALOG_DEDUPE_MS = 5 * 60 * 1000;
/**
 * Create opens the Assistant with the app-creation prompt. In a window the
 * shell's link bridge turns the link into the Assistant's own window.
 */
const CREATE_APP_HREF = "/dashboard/assistant?prompt=I+want+to+create+a+new+app";

/** A source tab: 44px on touch, where the tabs are a phone's source navigation */
const TAB_CLASS = "text-xs pointer-coarse:h-11 pointer-coarse:min-w-11";

/**
 * A category pill. On a phone these pills are the only category navigation
 * (the window sidebar replaces them), so on touch each is a 44px target. The
 * rail scrolls sideways and clips overflow, so the pill itself grows rather
 * than a hit area around it, and its focus ring is inset.
 */
function categoryPillClass(active: boolean) {
  return cn(
    "h-6 shrink-0 rounded-full border px-2 text-xs transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:px-3",
    active
      ? "border-foreground/30 bg-foreground/8 text-foreground"
      : "border-border text-muted-foreground hover:text-foreground",
  );
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
  const embeddedFrame = useIsEmbeddedFrame();
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

  const confirm = useConfirm();
  const [sourceErrors, setSourceErrors] = useState<Record<string, boolean>>({});
  const jsonFetcher = fetchJson;
  const swrOpts = { revalidateOnFocus: true, revalidateOnReconnect: true, keepPreviousData: true } as const;

  // The full catalog is several MB and changes rarely — don't refetch it on
  // every window focus or remount within a few minutes (explicit retries and
  // mutations still refresh it).
  const { loadedAt: catalogLoadedAt, markLoaded: markCatalogLoaded } = useLoadedAt();
  const { data: catalogData, mutate: mutateApps, error: appsError, isValidating: catalogValidating } = useSWR<CatalogApp[]>(
    `${CORE_URL}/api/apps?limit=2000`, jsonFetcher,
    { ...swrOpts, revalidateOnFocus: false, dedupingInterval: CATALOG_DEDUPE_MS, onSuccess: markCatalogLoaded },
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
  const { data: storesData } = useSWR<StoreSource[]>(
    `${CORE_URL}/api/stores`, jsonFetcher, swrOpts,
  );
  const stores = useMemo(() => storesData ?? [], [storesData]);
  // Undefined while /api/stores loads or after it failed: then we don't know
  // whether any sources exist, and the empty state must not claim there are none.
  const catalogEmpty = emptyCatalogCopy(storesData);
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
  // Loading means "no answer yet", not "no apps": an empty catalog (no
  // stores) is an answer and gets its own empty state, never a skeleton
  // that runs forever.
  const loading = catalogData === undefined && !appsError;
  const fetchError = appsError && catalogData === undefined ? "Check that the Talome server is reachable, then retry." : null;

  const fetchData = useCallback(() => {
    void mutateApps();
    void mutateInstalled();
  }, [mutateApps, mutateInstalled]);

  useEffect(() => {
    if (tab === "all" || tab === "installed") return;
    if (sourceCache[tab] || sourceErrors[tab]) return;

    let cancelled = false;
    fetch(`${CORE_URL}/api/apps?limit=2000&source=${encodeURIComponent(tab)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load source apps");
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSourceErrors((prev) => ({ ...prev, [tab]: false }));
        setSourceCache((prev) => ({ ...prev, [tab]: Array.isArray(data) ? data : [] }));
      })
      .catch(() => {
        if (cancelled) return;
        // Not an empty store: say it failed, with Retry.
        setSourceErrors((prev) => ({ ...prev, [tab]: true }));
      });

    return () => {
      cancelled = true;
    };
  }, [tab, sourceCache, sourceErrors]);

  const sourceTypes = useMemo(
    () => [...new Set(stores.map((s) => s.type))].sort(
      (a, b) => (SOURCE_TAB_ORDER[a] ?? 9) - (SOURCE_TAB_ORDER[b] ?? 9),
    ),
    [stores],
  );

  // Deleting a created app removes its source: a destructive confirmation
  // that runs the request, so a failure shows in the dialog with Retry.
  const handleDeleteUserApp = useCallback(async (appId: string) => {
    const app = (sourceCache["user-created"] ?? []).find((a) => a.id === appId) ?? apps.find((a) => a.id === appId);
    const name = app?.installed?.displayName || app?.name || appId;
    // Core uninstalls an installed app first and keeps the source files.
    const copy = deleteCreatedAppCopy(name, appId, !!app?.installed);
    await confirm({
      tier: "destructive",
      title: copy.title,
      consequence: copy.consequence,
      recovery: copy.recovery,
      irreversible: true,
      confirmLabel: copy.confirmLabel,
      busyLabel: copy.busyLabel,
      run: async () => {
        const res = await fetch(`${CORE_URL}/api/user-apps/${encodeURIComponent(appId)}`, { method: "DELETE", credentials: "include" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(`Couldn't delete ${name}${body?.error ? `: ${body.error}` : ""}. Retry, or check that the Talome server is reachable.`);
        }
        setSourceCache((prev) => {
          const cached = prev["user-created"];
          if (!cached) return prev;
          return { ...prev, "user-created": cached.filter((a) => a.id !== appId) };
        });
        await mutateApps((prev) => prev?.filter((a) => !(a.id === appId && a.storeId === "user-apps")), false);
      },
      receipt: copy.receipt,
    });
  }, [apps, confirm, mutateApps, sourceCache]);

  const isInstalled = tab === "installed";
  const currentApps = useMemo(
    () => (isInstalled ? installedApps : tab === "all" ? apps : (sourceCache[tab] || [])),
    [apps, installedApps, isInstalled, sourceCache, tab],
  );

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

  // Paging resets during render via `filterKey`, so these are plain setters.
  const changeSearch = useCallback((value: string) => {
    setSearch(value);
  }, []);
  const changeCategory = useCallback((value: string) => {
    setCategory(value);
  }, []);

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
  const sourceFailed = !hasSourceCache && !!sourceErrors[tab];
  // The source-tab fetch is in flight exactly while that tab has no cached result.
  const showSourceLoading = !isInstalled && !loading && !hasSourceCache && !sourceFailed;
  const loadingPhase = useLoadingPhase(loading || showSourceLoading);
  // The stacks rail fades at its edges (a mask, so it reads on window glass
  // too); the fade lifts on the side whose end card you're pointing at.
  const fadeLeft = hoveredStackIndex !== 0;
  const fadeRight = hoveredStackIndex !== stacks.length - 1;
  const stacksRailMask = fadeLeft && fadeRight
    ? "[mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)]"
    : fadeLeft
      ? "[mask-image:linear-gradient(to_right,transparent,black_1rem)]"
      : fadeRight
        ? "[mask-image:linear-gradient(to_right,black_calc(100%-1rem),transparent)]"
        : undefined;
  // In a desktop window, sources, your apps and categories live in a sidebar
  const showCategories = !isInstalled && tab !== "user-created" && categories.length > 0;
  const sidebar = (
    <SourceList label="App Store sidebar">
      <SourceListSection title="Discover">
        <SourceListItem icon={LayoutGridIcon} label="All apps" active={tab === "all"} onSelect={() => changeTab("all")} />
        {sourceTypes.filter((t) => t !== "user-created").map((t) => (
          <SourceListItem key={t} icon={Globe02Icon} label={sourceLabel(t)} active={tab === t} onSelect={() => changeTab(t)} />
        ))}
      </SourceListSection>
      <SourceListSection title="Library">
        <SourceListItem icon={Package02Icon} label="My Apps" active={tab === "user-created"} onSelect={() => changeTab("user-created")} />
        <SourceListItem
          icon={PackageOpenIcon}
          label="Installed"
          active={isInstalled}
          trailing={totalInstalled > 0 ? totalInstalled : undefined}
          onSelect={() => changeTab("installed")}
        />
      </SourceListSection>
      {showCategories && (
        <SourceListSection title="Categories">
          <SourceListItem label="All categories" active={category === "all"} onSelect={() => changeCategory("all")} />
          {categories.map((cat) => (
            <SourceListItem
              key={cat}
              label={categoryLabel(cat)}
              active={category === cat}
              onSelect={() => changeCategory(cat)}
            />
          ))}
        </SourceListSection>
      )}
    </SourceList>
  );

  return (
    <WindowSidebarLayout sidebar={sidebar}>
    <div className="flex min-w-0 flex-1 flex-col gap-5">
      <DesktopAppToolbar windowTitle={`${appStoreViewTitle(tab)}${showCategories && category !== "all" ? ` · ${categoryLabel(category)}` : ""}`} className="grid min-w-0 gap-3">
        {/* Source navigation, Create and search wrap by the content column.
            Wide windows put source navigation in the sidebar; the selected
            view is published as the window title in both layouts. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Where the sidebar is hidden (a narrow window, or classic) the
              tabs reach every place it does, My Apps and Installed included.
              On touch each tab is a 44px target. With every source on a
              phone the strip is wider than the screen, so it scrolls sideways
              instead of pushing the page off the screen. */}
          <Tabs
            className={cn(WINDOW_SIDEBAR_REPLACES, "min-w-0 max-w-full overflow-x-auto scrollbar-none")}
            value={tab}
            onValueChange={changeTab}
          >
            <TabsList className="pointer-coarse:h-12">
              <TabsTrigger value="all" className={TAB_CLASS}>All</TabsTrigger>
              {sourceTypes.map((t) => (
                <TabsTrigger key={t} value={t} className={TAB_CLASS}>
                  {t === "user-created" ? "My Apps" : sourceLabel(t)}
                </TabsTrigger>
              ))}
              <TabsTrigger value="installed" className={cn(TAB_CLASS, "px-2")} aria-label="Installed" title="Installed">
                <HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} aria-hidden="true" />
                {totalInstalled > 0 && <TabsBadge>{totalInstalled}</TabsBadge>}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {embeddedFrame && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:h-11 pointer-coarse:min-w-11"
              asChild
            >
              <Link href={CREATE_APP_HREF} title="Create an app with the Assistant">
                <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden="true" />
                {/* Labelled where the column has room; the name either way */}
                <span className="sr-only @md:not-sr-only">Create</span>
              </Link>
            </Button>
          )}

          <SearchField
            containerClassName="ml-auto min-w-40 flex-1 @xl:max-w-64"
            className="pointer-coarse:h-11"
            aria-label="Search apps"
            placeholder="Search apps…"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
          />
        </div>

        {/* ── Category pills — "All" pinned, the rest scroll ── */}
        {showCategories && (
          <div className={cn("flex min-w-0 items-center gap-1.5", WINDOW_SIDEBAR_REPLACES)}>
            <button
              type="button"
              aria-pressed={category === "all"}
              className={categoryPillClass(category === "all")}
              onClick={() => changeCategory("all")}
            >
              All
            </button>
            <div className="relative min-w-0 max-w-full flex-1">
              {/* The rail fades out at its end (a mask, so it reads on window glass too) */}
              <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    aria-pressed={category === cat}
                    className={categoryPillClass(category === cat)}
                    onClick={() => changeCategory(cat)}
                  >
                    {categoryLabel(cat)}
                  </button>
                ))}
                {/* Room to scroll the last pill clear of the fade */}
                <span aria-hidden="true" className="w-4 shrink-0" />
              </div>
            </div>
          </div>
        )}
      </DesktopAppToolbar>

      {/* ── Featured stacks ─────────────────────────────── */}
      {tab === "all" && !search && category === "all" && stacks.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Stacks</h2>
          <div className="stacks-scroll-rail -mt-2 -mb-2">
            <div className={`flex items-stretch gap-4 overflow-x-auto py-2 pr-1 pl-0.5 scrollbar-none ${stacksRailMask ?? ""}`}>
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

      {appsError && catalogData !== undefined && (
        <StaleRow loadedAt={catalogLoadedAt} subject="apps" onRetry={fetchData} retrying={catalogValidating} />
      )}

      {/* ── Results ─────────────────────────────────────── */}
      {loading || showSourceLoading || loadingPhase === "skeleton" ? (
        // Once shown, the skeleton stays its minimum time even if apps arrived.
        loadingPhase === "skeleton" ? (
          <div className="app-grid" aria-busy="true">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-[248px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="min-h-96" aria-busy="true" />
        )
      ) : fetchError ? (
        <ErrorState
          fill
          title="Couldn't load the App Store"
          description={fetchError}
          onRetry={fetchData}
        />
      ) : sourceFailed ? (
        <ErrorState
          fill
          title={`Couldn't load ${sourceLabel(tab)} apps`}
          description="Check that the Talome server is reachable, then retry."
          onRetry={() => setSourceErrors((prev) => ({ ...prev, [tab]: false }))}
        />
      ) : tab === "all" && apps.length === 0 ? (
        <EmptyState
          fill
          icon={Package01Icon}
          title={catalogEmpty.title}
          description={catalogEmpty.description}
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/settings/app-sources">{catalogEmpty.action}</Link>
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        tab === "user-created" ? (
          <EmptyState
            fill
            icon={Package02Icon}
            title="No apps yet"
            description="Describe what you want to run and Claude Code will build it for you."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href={CREATE_APP_HREF}>Create your first app</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState
            fill
            icon={isInstalled ? PackageOpenIcon : Package01Icon}
            title={isInstalled ? "No apps installed yet" : "No apps found"}
            description={
              isInstalled
                ? "Apps you install from the store show up here."
                : search
                  ? "Nothing in the store matches your search. Talome can build it for you."
                  : "Nothing in this source matches the current filter."
            }
            action={
              isInstalled ? (
                <Button variant="outline" size="sm" onClick={() => changeTab("all")}>
                  Browse the store
                </Button>
              ) : search ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/dashboard/assistant?prompt=${encodeURIComponent(`Create an app: ${search}`)}`}>
                    Create &ldquo;{search}&rdquo; with AI
                  </Link>
                </Button>
              ) : undefined
            }
          />
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
                <HugeiconsIcon icon={AiMagicIcon} size={24} className="text-dim-foreground" />
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
              <span className="text-xs text-muted-foreground">Loading more apps…</span>
            </div>
          )}
        </>
      )}
    </div>
    </WindowSidebarLayout>
  );
}
