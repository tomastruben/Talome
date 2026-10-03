"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import Image from "next/image";
import { desktopAppArtwork } from "@/lib/desktop-app-artwork";
import { Dialog as DialogPrimitive } from "radix-ui";
import { motion, useReducedMotion } from "motion/react";
import {
  HugeiconsIcon,
  Cancel01Icon,
  DashboardSquareEditIcon,
  PackageOpenIcon,
  Search01Icon,
  Tick01Icon,
  ViewOffSlashIcon,
} from "@/components/icons";
import { allNav, type NavItem } from "@/components/layout/nav-config";
import {
  extractLaunchableApps,
  LaunchableAppIcon,
  type LaunchableApp,
} from "@/components/widgets/launcher-widget";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, FOCUS_RING_INSET } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useUser } from "@/hooks/use-user";
import { useLaunchpadVisibility } from "@/hooks/use-launchpad-visibility";
import { DURATION, tween } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** What an app tile stands for: a Talome app (nav item) or an installed web app. */
export type LaunchpadTarget = { item: NavItem } | { app: LaunchableApp };
/** A window for the app exists: open (dot) or minimized (hollow dot), as in the Dock. */
export type LaunchpadWindowState = "open" | "minimized";

interface DesktopLaunchpadProps {
  open: boolean;
  zIndex: number;
  onOpenChange: (open: boolean) => void;
  onLaunch: (item: NavItem) => void;
  onLaunchService: (app: LaunchableApp) => void;
  /** The Dock's Launchpad item: the panel sits above the Dock and grows out of it. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Whether the app already has a window, so its tile can carry the Dock's dot. */
  windowState?: (target: LaunchpadTarget) => LaunchpadWindowState | undefined;
}

/**
 * Enter launches the best match across both sections: exact name, then
 * prefix, then contains (not "services first", which opened Jellyseerr for
 * "Jellyfin" when the service was listed before the Talome app).
 */
export function launchpadMatchRank(name: string, search: string): number {
  const value = name.toLocaleLowerCase();
  if (!search) return 3;
  if (value === search) return 0;
  if (value.startsWith(search)) return 1;
  if (value.includes(search)) return 2;
  return 4;
}

export interface LaunchpadTileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Tiles whose tops differ by less than this share a row. */
const ROW_TOLERANCE = 4;

/**
 * Up/Down in the grid: the closest row below (dir 1) or above (dir -1) by top
 * edge, so it crosses the gap between the Talome and installed groups, then
 * the tile in that row whose centre is nearest horizontally (a ragged last row
 * lands on its last tile). At the edge the selection stays put.
 */
export function nearestInRow(rects: readonly LaunchpadTileRect[], index: number, dir: 1 | -1): number {
  const from = rects[index];
  if (!from) return index;
  let rowDistance = Infinity;
  for (const rect of rects) {
    const dy = (rect.top - from.top) * dir;
    if (dy > ROW_TOLERANCE && dy < rowDistance) rowDistance = dy;
  }
  if (rowDistance === Infinity) return index;
  const centre = from.left + from.width / 2;
  let best = index;
  let bestDistance = Infinity;
  rects.forEach((rect, candidate) => {
    if (Math.abs((rect.top - from.top) * dir - rowDistance) > ROW_TOLERANCE) return;
    const distance = Math.abs(rect.left + rect.width / 2 - centre);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  });
  return best;
}

interface LaunchpadEntry {
  /** DOM-safe, unique: the option id is `lp-${key}`. */
  key: string;
  /** useLaunchpadVisibility key: `builtin:<url>` or `service:<id>`. */
  visibilityKey: string;
  name: string;
  /** Shown only to tell apart installs that share a name. */
  collection?: string;
  /** Lower-cased text the search matches against. */
  haystack: string;
  /** Lower-cased fields ranked for the best match. */
  rankFields: string[];
  stopped: boolean;
  hidden: boolean;
  windowState?: LaunchpadWindowState;
  /** Talome apps first, then installed apps, in browse order. */
  order: number;
  icon: ReactNode;
  launch: () => void;
}

const domKey = (raw: string) => raw.replace(/[^A-Za-z0-9_-]+/g, "-");

const TILE =
  "group relative isolate flex min-w-0 cursor-default flex-col items-center rounded-xl px-1 pt-2 pb-1.5 transition-colors duration-150 hover:bg-foreground/5";
const GRID = "grid grid-cols-6 gap-1";
const BOTTOM_FALLBACK = "calc(var(--desktop-dock-reserve, 5.75rem) + 0.5rem)";

/**
 * The least the locked panel may be: the tallest state a sparse browse view can
 * switch to without reopening. The search empty state needs about 16.25rem
 * (17.25rem when its line wraps on a narrow screen); Customize needs its footer
 * and one row of tiles (about 14.5rem). In rem, so it grows with the text.
 */
export const LAUNCHPAD_MIN_HEIGHT = "17.5rem";

/**
 * The locked height: the measured browse height, never below the floor, so
 * Customize (with Reset) and "No apps found" always fit. The panel's max-height
 * still caps it on a short screen, where the body scrolls.
 */
export function launchpadLockedHeight(natural: number | null): string | undefined {
  return natural === null ? undefined : `max(${natural}px, ${LAUNCHPAD_MIN_HEIGHT})`;
}

/** Keeps DOM focus in the search field while a tile or the grid is clicked. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

function tileLabel(entry: LaunchpadEntry) {
  return `${entry.name}${entry.collection ? ` — ${entry.collection}` : ""}${entry.stopped ? " — Stopped" : ""}`;
}

function LaunchpadTile({
  entry,
  variant,
  selected = false,
  markHidden = false,
  reduceMotion = false,
  onActivate,
}: {
  entry: LaunchpadEntry;
  /** `option` in browse and search; `toggle` (a pressed button) in Customize. */
  variant: "option" | "toggle";
  selected?: boolean;
  /** Search lists hidden apps too, marked "Hidden". */
  markHidden?: boolean;
  reduceMotion?: boolean;
  onActivate: () => void;
}) {
  const editing = variant === "toggle";
  const hiddenMark = markHidden && entry.hidden;
  const label = tileLabel(entry);
  const windowState = editing ? undefined : entry.windowState;
  const secondary = [entry.collection, entry.stopped ? "Stopped" : undefined, hiddenMark ? "Hidden" : undefined]
    .filter(Boolean)
    .join(" · ");

  const content = (
    <span className="relative z-10 flex w-full min-w-0 flex-col items-center gap-1.5">
      {/* In Customize the icon and its badge sway like a home screen in edit
          mode (globals.css tm-jiggle-icon); otherwise a press dips it */}
      <span
        aria-hidden="true"
        className={cn(
          "relative size-14 transition-transform duration-100",
          editing ? "tm-jiggle-icon" : "motion-safe:group-active:scale-96",
        )}
      >
        {/* Stopped is grey. A hidden app in Customize dims its icon only: the name
            and second line stay at full strength (AA on the glass), and the empty
            badge and aria-pressed carry the hidden state. */}
        <span
          className={cn(
            "block size-14",
            editing && entry.hidden ? "opacity-45 grayscale" : entry.stopped && "opacity-50 grayscale",
          )}
        >
          {entry.icon}
        </span>
        {editing ? (
          <span
            className={cn(
              "absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full border-2 border-card motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-enter",
              entry.hidden ? "bg-muted" : "bg-primary text-primary-foreground",
            )}
          >
            {!entry.hidden && <HugeiconsIcon icon={Tick01Icon} className="size-3" />}
          </span>
        ) : null}
      </span>
      <span className="w-full truncate text-center text-sm leading-tight">{entry.name}</span>
      {secondary ? (
        // Muted text never sits on the selection plate
        <span className={cn("w-full truncate text-center text-xs", selected ? "text-foreground" : "text-muted-foreground")}>
          {entry.stopped ? (
            <StatusDot state="stopped" size="sm" label="Stopped" hideLabel className="mr-1 align-middle" />
          ) : null}
          {secondary}
        </span>
      ) : null}
    </span>
  );

  if (editing) {
    return (
      <button
        type="button"
        aria-pressed={!entry.hidden}
        aria-label={`${entry.hidden ? "Show" : "Hide"} ${label}`}
        title={label}
        data-launchpad-tile=""
        data-launchpad-stopped={entry.stopped || undefined}
        className={cn(TILE, FOCUS_RING_INSET, "tm-jiggle-tile")}
        onClick={onActivate}
      >
        {content}
      </button>
    );
  }

  const name = `${label}${windowState === "open" ? " — Open" : windowState === "minimized" ? " — Minimized" : ""}${hiddenMark ? " — Hidden" : ""}`;
  return (
    <div
      role="option"
      id={`lp-${entry.key}`}
      aria-selected={selected}
      aria-label={name}
      title={label}
      data-launchpad-tile=""
      data-launchpad-stopped={entry.stopped || undefined}
      className={TILE}
      onMouseDown={keepFocus}
      onClick={onActivate}
    >
      {selected ? (
        <motion.span
          layoutId="launchpad-selection"
          aria-hidden="true"
          className="absolute inset-0 z-0 rounded-xl bg-foreground/8 ring-2 ring-ring ring-inset"
          transition={reduceMotion ? { duration: 0 } : tween(DURATION.fast)}
        />
      ) : null}
      {content}
      {/* The Dock's grammar: open is a dot, minimized a hollow dot */}
      {windowState ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute bottom-0.5 left-1/2 z-10 size-1 -translate-x-1/2 rounded-full",
            windowState === "minimized" ? "bg-transparent ring-1 ring-foreground/70" : "bg-foreground/70",
          )}
        />
      ) : null}
    </div>
  );
}

type MeasureStage = "pending" | "awaiting-load" | "done";

export function DesktopLaunchpad({
  open,
  zIndex,
  onOpenChange,
  onLaunch,
  onLaunchService,
  anchorRef,
  windowState,
}: DesktopLaunchpadProps) {
  const { user, hasPermission } = useUser();
  const { stacks, isLoading, error, refresh } = useServiceStacks();
  const reduceMotion = useReducedMotion() ?? false;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const visibility = useLaunchpadVisibility(user?.userId);
  const [retrying, setRetrying] = useState(false);
  /** "text": Left/Right/Home/End edit the query. "grid": they move the selection. */
  const [keyMode, setKeyMode] = useState<"text" | "grid">("text");
  const [gridKey, setGridKey] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [placement, setPlacement] = useState<{ bottom: number | null; originX: number | null }>({ bottom: null, originX: null });
  const [measure, setMeasure] = useState<{ height: number | null; stage: MeasureStage }>({ height: null, stage: "pending" });
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const inputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();

  // Every opening starts in browse mode, at its natural height (measured again).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setEditing(false);
      setStorageError(false);
      setKeyMode("text");
      setGridKey(null);
      setScrolled(false);
      setMeasure({ height: null, stage: "pending" });
    }
  }

  // Stopped apps stay listed (dimmed, "Stopped") so nobody mistakes them for uninstalled.
  const launchableApps = extractLaunchableApps(stacks, { includeStopped: true })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.collection ?? "").localeCompare(b.collection ?? ""));
  const duplicateNames = new Map<string, number>();
  for (const app of launchableApps) duplicateNames.set(app.name, (duplicateNames.get(app.name) ?? 0) + 1);
  const availableApps = allNav.filter((item) => (
    !item.action
    && item.url !== "/dashboard"
    && (!item.adminOnly || user?.role === "admin")
    && (!item.permission || hasPermission(item.permission))
  ));
  const appStore = availableApps.find((item) => item.url === "/dashboard/apps");

  const usedKeys = new Set<string>();
  const uniqueKey = (raw: string) => {
    const base = domKey(raw);
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}-${n}`;
    usedKeys.add(key);
    return key;
  };
  const builtins: LaunchpadEntry[] = availableApps.map((item, index) => ({
    key: uniqueKey(`b-${item.url.replace(/^\/+/, "")}`),
    visibilityKey: `builtin:${item.url}`,
    name: item.title,
    haystack: item.title.toLocaleLowerCase(),
    rankFields: [item.title],
    stopped: false,
    hidden: visibility.hidden.has(`builtin:${item.url}`),
    windowState: windowState?.({ item }),
    order: index,
    icon: (
      <span className="desktop-app-icon relative flex size-14 items-center justify-center bg-background/70">
        {desktopAppArtwork(item.url) ? (
          <Image src={desktopAppArtwork(item.url)!} alt="" fill sizes="56px" loading="eager" className="object-contain" />
        ) : (
          <HugeiconsIcon icon={item.icon} className="size-7" strokeWidth={1.5} />
        )}
      </span>
    ),
    launch: () => onLaunch(item),
  }));
  const services: LaunchpadEntry[] = launchableApps.map((app, index) => ({
    key: uniqueKey(`s-${app.id}`),
    visibilityKey: `service:${app.id}`,
    name: app.name,
    collection: (duplicateNames.get(app.name) ?? 0) > 1 ? app.collection ?? app.container.name : undefined,
    haystack: `${app.name} ${app.collection ?? ""}`.toLocaleLowerCase(),
    rankFields: [app.name, app.collection ?? ""],
    stopped: app.running === false,
    hidden: visibility.hidden.has(`service:${app.id}`),
    windowState: windowState?.({ app }),
    order: builtins.length + index,
    icon: <LaunchableAppIcon app={app} desktop className="!size-14" iconClassName="!size-7" />,
    launch: () => onLaunchService(app),
  }));

  const search = query.trim().toLocaleLowerCase();
  const searching = search !== "";
  const matches = (entry: LaunchpadEntry) => entry.haystack.includes(search);
  const rank = (entry: LaunchpadEntry) => Math.min(...entry.rankFields.map((field) => launchpadMatchRank(field, search)));

  const talomeBrowse = builtins.filter((entry) => !entry.hidden);
  const installedBrowse = services.filter((entry) => !entry.hidden);
  // Search finds hidden apps too (marked "Hidden"): best match first, then
  // visible before hidden, running before stopped, then browse order.
  const results = searching
    ? [...builtins, ...services]
      .filter(matches)
      .map((entry) => ({ entry, rank: rank(entry) }))
      .sort((a, b) => (
        a.rank - b.rank
        || Number(a.entry.hidden) - Number(b.entry.hidden)
        || Number(a.entry.stopped) - Number(b.entry.stopped)
        || a.entry.order - b.entry.order
      ))
      .map(({ entry }) => entry)
    : [];
  const talomeGroup = editing ? builtins.filter((entry) => !searching || matches(entry)) : talomeBrowse;
  const installedGroup = editing ? services.filter((entry) => !searching || matches(entry)) : installedBrowse;
  const options = editing ? [] : searching ? results : [...talomeBrowse, ...installedBrowse];
  const listboxShown = options.length > 0;

  // Typing selects the best match; the arrow keys take over until the next edit.
  const selectedKey = editing
    ? null
    : keyMode === "grid"
      ? (options.some((entry) => entry.key === gridKey) ? gridKey : null)
      : (searching ? options[0]?.key ?? null : null);
  const selectedIndex = selectedKey === null ? -1 : options.findIndex((entry) => entry.key === selectedKey);

  const visibleCount = talomeBrowse.length + installedBrowse.length;
  const placeholder = isLoading || error || visibleCount === 0
    ? "Search apps"
    : `Search ${visibleCount} ${visibleCount === 1 ? "app" : "apps"}`;
  const found = editing ? talomeGroup.length + installedGroup.length : results.length;
  const announcement = searching
    ? `${found} ${found === 1 ? "app" : "apps"} found${isLoading ? "; installed apps are loading" : ""}`
    : "";

  const toggle = (key: string) => setStorageError(!visibility.toggle(key));

  const retry = async () => {
    setRetrying(true);
    try {
      await refresh();
    } catch {
      // SWR retains the error so the retry remains available.
    } finally {
      setRetrying(false);
    }
  };

  const clearQuery = (focusInput: boolean) => {
    setQuery("");
    setKeyMode("text");
    setGridKey(null);
    if (focusInput) inputRef.current?.focus();
  };

  const select = (index: number) => {
    const entry = options[index];
    if (!entry) return;
    setKeyMode("grid");
    setGridKey(entry.key);
  };

  const tileRects = (): LaunchpadTileRect[] => Array.from(
    listboxRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    (element) => element.getBoundingClientRect(),
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || editing) return;
    const last = options.length - 1;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (last < 0) return;
        const dir = event.key === "ArrowDown" ? 1 : -1;
        select(selectedIndex < 0 ? (dir === 1 ? 0 : last) : nearestInRow(tileRects(), selectedIndex, dir));
        return;
      }
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End": {
        if (keyMode !== "grid" || selectedIndex < 0) return;
        event.preventDefault();
        if (event.key === "Home") select(0);
        else if (event.key === "End") select(last);
        else select(Math.min(last, Math.max(0, selectedIndex + (event.key === "ArrowRight" ? 1 : -1))));
        return;
      }
      case "Enter": {
        // Nothing is selected until you type or use the arrow keys.
        if (selectedIndex < 0) return;
        event.preventDefault();
        options[selectedIndex].launch();
        return;
      }
      case "Backspace":
        setKeyMode("text");
        return;
    }
  };

  // Above the Dock, growing out of the Launchpad item.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef?.current ?? null;
      const dock = anchor?.closest("nav")?.getBoundingClientRect();
      const bottom = dock && dock.height > 0 ? Math.round(window.innerHeight - dock.top + 12) : null;
      const anchorRect = anchor?.getBoundingClientRect();
      let originX: number | null = null;
      if (anchorRect && anchorRect.width > 0 && panel && panel.offsetWidth > 0) {
        const width = panel.offsetWidth;
        const left = (document.documentElement.clientWidth - width) / 2;
        originX = Math.round(Math.min(Math.max(anchorRect.left + anchorRect.width / 2 - left, 24), width - 24));
      }
      setPlacement((current) => (
        current.bottom === bottom && current.originX === originX ? current : { bottom, originX }
      ));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, anchorRef, panel]);

  // Lock the height after the first browse layout (and once more when the
  // installed apps arrive), so nothing jumps under the pointer while typing,
  // customizing or selecting: the body scrolls instead.
  useLayoutEffect(() => {
    if (!open || !panel || editing || searching) return;
    if (measure.stage === "done" || (measure.stage === "awaiting-load" && isLoading)) return;
    const header = headerRef.current;
    const body = bodyRef.current;
    if (!header || !body) return;
    const locked = panel.style.height;
    panel.style.height = "auto";
    const natural = Math.ceil(panel.offsetHeight - panel.clientHeight + header.offsetHeight + body.scrollHeight);
    panel.style.height = locked;
    setMeasure({
      height: natural > 0 ? natural : null,
      stage: measure.stage === "pending" && isLoading ? "awaiting-load" : "done",
    });
  }, [open, panel, editing, searching, measure.stage, isLoading]);

  useEffect(() => {
    if (!selectedKey) return;
    document.getElementById(`lp-${selectedKey}`)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  const bottom = placement.bottom === null ? BOTTOM_FALLBACK : `${placement.bottom}px`;
  // Tall enough for five rows of apps plus search on a typical screen (the
  // owner asked to fit more), never past 1.5rem from the top edge.
  const maxHeight = `min(42rem, calc(100dvh - ${bottom} - 1.5rem))`;
  const panelStyle: CSSProperties = {
    zIndex,
    width: "min(38rem, calc(100vw - 2rem))",
    bottom,
    maxHeight,
    height: launchpadLockedHeight(measure.height),
    transformOrigin: placement.originX === null ? "50% 100%" : `${placement.originX}px calc(100% + 12px)`,
  };

  const renderTile = (entry: LaunchpadEntry, markHidden = false) => (
    <LaunchpadTile
      key={entry.key}
      entry={entry}
      variant={editing ? "toggle" : "option"}
      selected={entry.key === selectedKey}
      markHidden={markHidden}
      reduceMotion={reduceMotion}
      onActivate={() => (editing ? toggle(entry.visibilityKey) : entry.launch())}
    />
  );

  const hairline = <div aria-hidden="true" className="mx-2 h-px bg-border/60" />;

  const errorAlert = error ? (
    <Alert>
      <AlertTitle>Installed apps couldn’t be loaded</AlertTitle>
      <AlertDescription>
        <p>Check your connection to Talome, then try again.</p>
        <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
          {retrying ? "Retrying…" : "Try again"}
        </Button>
      </AlertDescription>
    </Alert>
  ) : null;

  const noResults = (
    <EmptyState
      icon={Search01Icon}
      title="No apps found"
      description={`No apps match “${query.trim()}”. Background services are in Services.`}
      action={<Button variant="outline" onClick={() => clearQuery(true)}>Clear search</Button>}
      className="p-6"
    />
  );

  // Not options: status blocks sit outside the listbox, where the installed group would be.
  const installedStatus = installedGroup.length > 0 ? null : isLoading ? (
    <div role="status" aria-label="Loading installed apps" className={GRID}>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex flex-col items-center gap-1.5 px-1 pt-2 pb-1.5">
          <Skeleton className="size-14 rounded-xl" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  ) : error ? errorAlert : !searching && launchableApps.length === 0 ? (
    <div className="flex items-center gap-3 px-2 py-2">
      <HugeiconsIcon icon={PackageOpenIcon} aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">Apps with a browser interface appear here.</p>
      {appStore ? (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onLaunch(appStore)}>
          Open App Store
        </Button>
      ) : null}
    </div>
  ) : null;

  // Every app hidden: say so, instead of an empty panel under the search field.
  const allHidden = !editing && !searching && visibleCount === 0 && !installedStatus
    && builtins.length + services.length > 0 ? (
      <div className="flex items-center gap-3 px-2 py-2">
        <HugeiconsIcon icon={ViewOffSlashIcon} aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Every app is hidden. Search still finds them.</p>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 phone-touch:h-11"
          onClick={() => {
            setEditing(true);
            // This row goes away: keep focus in the panel, on Done
            trailingRef.current?.focus();
          }}
        >
          Customize
        </Button>
      </div>
    ) : null;

  const groups = (
    <>
      {talomeGroup.length > 0 ? (
        <div role="group" aria-label="Talome apps" className={GRID}>
          {talomeGroup.map((entry) => renderTile(entry))}
        </div>
      ) : null}
      {talomeGroup.length > 0 && installedGroup.length > 0 ? hairline : null}
      {installedGroup.length > 0 ? (
        <div role="group" aria-label="Installed apps" className={GRID}>
          {installedGroup.map((entry) => renderTile(entry))}
        </div>
      ) : null}
    </>
  );

  const groupsView = (
    <>
      {editing ? (
        <div className="flex flex-col gap-2">{groups}</div>
      ) : listboxShown ? (
        <div ref={listboxRef} role="listbox" id={listboxId} aria-label="Apps" className="flex flex-col gap-2" onMouseDown={keepFocus}>
          {groups}
        </div>
      ) : null}
      {installedStatus ? (
        <>
          {talomeGroup.length > 0 ? hairline : null}
          {installedStatus}
        </>
      ) : null}
      {allHidden}
      {/* Stale apps stay listed after a failed refresh, with the way to retry under them */}
      {installedGroup.length > 0 ? errorAlert : null}
      {editing && searching && !isLoading && !error && talomeGroup.length + installedGroup.length === 0 ? noResults : null}
    </>
  );

  const searchView = (
    <>
      {errorAlert}
      {results.length > 0 ? (
        <div ref={listboxRef} role="listbox" id={listboxId} aria-label="Apps" className={GRID} onMouseDown={keepFocus}>
          {results.map((entry) => renderTile(entry, true))}
        </div>
      ) : !isLoading && !error ? noResults : null}
      {isLoading ? <p className="px-2 text-xs text-muted-foreground">Loading installed apps…</p> : null}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        {/* No scrim: the desktop stays sharp. A click outside only closes Launchpad, as a popover. */}
        <DialogOverlay className="fixed inset-0 bg-transparent" style={{ zIndex }} />
        <DialogPrimitive.Content
          ref={setPanel}
          style={panelStyle}
          className={cn(
            "tm-glass-dense fixed left-1/2 flex -translate-x-1/2 flex-col overflow-hidden rounded-2xl border shadow-lg outline-none",
            // 180ms in, scaling from 0.96 and rising 6px (TRAVEL.lift; tw-animate has no
            // 1.5 step) out of the Launchpad item; 120ms back toward it
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-96 data-[state=open]:slide-in-from-bottom-[6px] data-[state=open]:duration-180 data-[state=open]:ease-enter",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 data-[state=closed]:slide-out-to-bottom-1 data-[state=closed]:duration-120 data-[state=closed]:ease-exit",
            // Reduced motion: a 120ms fade both ways. Scoped to the same data-state
            // variants, or the open duration (more specific) would win.
            "motion-reduce:data-[state=open]:zoom-in-100 motion-reduce:data-[state=closed]:zoom-out-100 motion-reduce:data-[state=open]:slide-in-from-bottom-0 motion-reduce:data-[state=closed]:slide-out-to-bottom-0 motion-reduce:data-[state=open]:duration-120",
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setQuery("");
            setEditing(false);
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // This runs after the 120ms exit, once the panel is gone. A launch has
            // already moved focus into its window by then: leave it there, so the
            // keystrokes after "type, Enter" reach the app. Return focus to the
            // trigger only when it went down with the panel (Escape, a click outside,
            // a launch that opened nothing).
            const active = document.activeElement;
            const lost = !active || active === document.body || (panel?.contains(active) ?? false);
            if (lost && returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            // Escape while composing ends the composition, nothing else
            if (event.isComposing) {
              event.preventDefault();
              return;
            }
            // The first Escape clears the search; the next one closes
            if (query) {
              event.preventDefault();
              clearQuery(false);
            }
          }}
        >
          <DialogTitle className="sr-only">Launchpad</DialogTitle>
          <DialogDescription className="sr-only">
            {editing ? "Choose which apps appear here." : "Type to search, use the arrow keys to choose, Enter to open."}
          </DialogDescription>

          <div
            ref={headerRef}
            className={cn(
              "flex h-12 shrink-0 items-center gap-2 border-b px-4 transition-[border-color] duration-150 ease-enter",
              scrolled ? "border-border/60" : "border-transparent",
            )}
          >
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label="Search apps"
              aria-expanded={listboxShown}
              aria-controls={listboxShown ? listboxId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={selectedKey ? `lp-${selectedKey}` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setKeyMode("text");
                setGridKey(null);
              }}
              onKeyDown={handleKeyDown}
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-6 rounded-full phone-touch:size-11"
                aria-label="Clear search"
                onClick={() => clearQuery(true)}
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                {/* One control: Customize becomes Done (the one primary action) in place */}
                <Button
                  ref={trailingRef}
                  variant={editing ? "default" : "ghost"}
                  size={editing ? "default" : "icon"}
                  aria-label={editing ? undefined : "Customize"}
                  className={editing
                    ? "h-7 rounded-full px-3 text-sm phone-touch:h-11"
                    : "size-7 rounded-full phone-touch:size-11"}
                  onClick={() => {
                    setEditing((current) => !current);
                    setKeyMode("text");
                    setGridKey(null);
                  }}
                >
                  {editing ? "Done" : <HugeiconsIcon icon={DashboardSquareEditIcon} className="size-4" />}
                </Button>
              </TooltipTrigger>
              {!editing ? (
                <TooltipContent side="top" sideOffset={8} style={{ zIndex: zIndex + 1 }}>
                  Customize
                </TooltipContent>
              ) : null}
            </Tooltip>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="hidden size-11 rounded-full pointer-coarse:inline-flex"
                aria-label="Close Launchpad"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <p role="status" className="sr-only">{announcement}</p>

          <motion.div
            ref={bodyRef}
            layoutScroll
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3"
            onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
          >
            {editing && storageError ? (
              <Alert variant="destructive">
                <AlertDescription>Your browser couldn’t save this change. Allow local storage and try again.</AlertDescription>
              </Alert>
            ) : null}
            {searching && !editing ? searchView : groupsView}
          </motion.div>

          {editing ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-4 py-2">
              <p className="text-xs text-muted-foreground">Hidden apps keep running. Saved for you in this browser.</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 text-xs phone-touch:h-11"
                disabled={visibility.hidden.size === 0}
                onClick={() => {
                  setStorageError(!visibility.reset());
                  // Reset disables itself: keep focus in the panel
                  trailingRef.current?.focus();
                }}
              >
                Reset
              </Button>
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
