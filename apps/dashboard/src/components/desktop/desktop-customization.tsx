"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Image from "next/image";
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  DashboardSquareEditIcon,
  HugeiconsIcon,
  Image01Icon,
  ImageAdd01Icon,
  Tick01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import {
  ControlledWidgetGrid,
  type WidgetLayoutController,
} from "@/components/widgets/widget-grid";
import { cn } from "@/lib/utils";

const MAX_WALLPAPER_BYTES = 2 * 1024 * 1024;
const WALLPAPER_DIALOG_VIEWPORT_MARGIN = 16;

const RETIRED_WALLPAPER_URLS = new Set([
  "/wallpapers/generated/talome-16.jpg",
  "/wallpapers/generated/talome-20.jpg",
  "/wallpapers/generated/talome-29.jpg",
  "/wallpapers/generated/talome-32.jpg",
]);

export function normalizeDesktopWallpaperUrl(
  wallpaperUrl?: string | null,
): string | undefined {
  if (!wallpaperUrl || RETIRED_WALLPAPER_URLS.has(wallpaperUrl)) return undefined;
  return wallpaperUrl;
}

interface WallpaperDialogPosition {
  x: number;
  y: number;
}

interface WallpaperDialogDragOrigin {
  pointerX: number;
  pointerY: number;
  position: WallpaperDialogPosition;
  bounds: DOMRect;
}

interface WallpaperPreset {
  id: string;
  name: string;
  url?: string;
}

export interface DesktopWallpaperAttribution {
  photoUrl: string;
  photographerName: string;
  photographerUrl: string;
  providerName?: string;
}

const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  { id: "default", name: "Talome" },
  { id: "alpenglow", name: "Alpenglow", url: "/wallpapers/alpenglow.jpg" },
  { id: "aurora", name: "Aurora", url: "/wallpapers/aurora.jpg" },
  { id: "forest", name: "Misty Forest", url: "/wallpapers/misty-forest.jpg" },
  { id: "dune", name: "Dune", url: "/wallpapers/dune.jpg" },
  {
    id: "alpine-stillness",
    name: "Alpine Stillness",
    url: "/wallpapers/generated/talome-01.jpg",
  },
  {
    id: "black-dunes",
    name: "Black Dunes",
    url: "/wallpapers/generated/talome-02.jpg",
  },
  {
    id: "redwood-mist",
    name: "Redwood Mist",
    url: "/wallpapers/generated/talome-03.jpg",
  },
  {
    id: "polar-aurora",
    name: "Polar Aurora",
    url: "/wallpapers/generated/talome-04.jpg",
  },
  {
    id: "silver-cliffs",
    name: "Silver Cliffs",
    url: "/wallpapers/generated/talome-05.jpg",
  },
  {
    id: "crimson-snow",
    name: "Crimson Snow",
    url: "/wallpapers/generated/talome-06.jpg",
  },
  {
    id: "mediterranean-light",
    name: "Mediterranean Light",
    url: "/wallpapers/generated/talome-07.jpg",
  },
  {
    id: "moonlit-coast",
    name: "Moonlit Coast",
    url: "/wallpapers/generated/talome-08.jpg",
  },
  {
    id: "ink-mountains",
    name: "Ink Mountains",
    url: "/wallpapers/generated/talome-09.jpg",
  },
  {
    id: "paper-canyon",
    name: "Paper Canyon",
    url: "/wallpapers/generated/talome-10.jpg",
  },
  {
    id: "alpine-gouache",
    name: "Alpine Gouache",
    url: "/wallpapers/generated/talome-11.jpg",
  },
  {
    id: "liquid-glass",
    name: "Liquid Glass",
    url: "/wallpapers/generated/talome-13.jpg",
  },
  {
    id: "pearl-gradient",
    name: "Pearl Gradient",
    url: "/wallpapers/generated/talome-14.jpg",
  },
  {
    id: "bauhaus-horizon",
    name: "Bauhaus Horizon",
    url: "/wallpapers/generated/talome-15.jpg",
  },
  {
    id: "desert-observatory",
    name: "Desert Observatory",
    url: "/wallpapers/generated/talome-18.jpg",
  },
  {
    id: "submerged-light",
    name: "Submerged Light",
    url: "/wallpapers/generated/talome-19.jpg",
  },
  {
    id: "luminous-fold",
    name: "Luminous Fold",
    url: "/wallpapers/generated/talome-21.jpg",
  },
  {
    id: "talome-flux",
    name: "Talome Flux",
    url: "/wallpapers/generated/talome-22.jpg",
  },
  {
    id: "orbital-bloom",
    name: "Orbital Bloom",
    url: "/wallpapers/generated/talome-23.jpg",
  },
  {
    id: "mineral-gradient",
    name: "Mineral Gradient",
    url: "/wallpapers/generated/talome-24.jpg",
  },
  {
    id: "glacier-dawn",
    name: "Glacier Dawn",
    url: "/wallpapers/generated/talome-25.jpg",
  },
  {
    id: "cloud-forest",
    name: "Cloud Forest",
    url: "/wallpapers/generated/talome-26.jpg",
  },
  {
    id: "volcanic-coast",
    name: "Volcanic Coast",
    url: "/wallpapers/generated/talome-27.jpg",
  },
  {
    id: "desert-rain",
    name: "Desert Rain",
    url: "/wallpapers/generated/talome-28.jpg",
  },
  {
    id: "crimson-ring",
    name: "Crimson Ring",
    url: "/wallpapers/generated/talome-30.jpg",
  },
  {
    id: "glass-forest",
    name: "Glass Forest",
    url: "/wallpapers/generated/talome-31.jpg",
  },
  {
    id: "ivory-basin",
    name: "Ivory Basin",
    url: "/wallpapers/generated/talome-33.jpg",
  },
  {
    id: "salt-horizon",
    name: "Salt Horizon",
    url: "/wallpapers/generated/talome-34.jpg",
  },
  {
    id: "quiet-ochre",
    name: "Quiet Ochre",
    url: "/wallpapers/generated/talome-35.jpg",
  },
  {
    id: "slate-lake",
    name: "Slate Lake",
    url: "/wallpapers/generated/talome-36.jpg",
  },
  {
    id: "clay-silence",
    name: "Clay Silence",
    url: "/wallpapers/generated/talome-37.jpg",
  },
  {
    id: "frosted-valley",
    name: "Frosted Valley",
    url: "/wallpapers/generated/talome-38.jpg",
  },
  {
    id: "moss-line",
    name: "Moss Line",
    url: "/wallpapers/generated/talome-39.jpg",
  },
  {
    id: "pearl-coast",
    name: "Pearl Coast",
    url: "/wallpapers/generated/talome-40.jpg",
  },
  {
    id: "paper-tides",
    name: "Paper Tides",
    url: "/wallpapers/generated/talome-41.jpg",
  },
  {
    id: "cobalt-ribbon",
    name: "Cobalt Ribbon",
    url: "/wallpapers/generated/talome-42.jpg",
  },
  {
    id: "terracotta-drift",
    name: "Terracotta Drift",
    url: "/wallpapers/generated/talome-43.jpg",
  },
  {
    id: "pearl-curves",
    name: "Pearl Curves",
    url: "/wallpapers/generated/talome-44.jpg",
  },
  {
    id: "midnight-fold",
    name: "Midnight Fold",
    url: "/wallpapers/generated/talome-45.jpg",
  },
  {
    id: "sage-contours",
    name: "Sage Contours",
    url: "/wallpapers/generated/talome-46.jpg",
  },
  {
    id: "mineral-veil",
    name: "Mineral Veil",
    url: "/wallpapers/generated/talome-47.jpg",
  },
  {
    id: "porcelain-current",
    name: "Porcelain Current",
    url: "/wallpapers/generated/talome-48.jpg",
  },
  {
    id: "quiet-fjord",
    name: "Quiet Fjord",
    url: "/wallpapers/generated/talome-49.jpg",
  },
  {
    id: "desert-mirror",
    name: "Desert Mirror",
    url: "/wallpapers/generated/talome-50.jpg",
  },
  {
    id: "ring-garden",
    name: "Ring Garden",
    url: "/wallpapers/generated/talome-51.jpg",
  },
  {
    id: "twin-moons",
    name: "Twin Moons",
    url: "/wallpapers/generated/talome-52.jpg",
  },
  {
    id: "azure-bloom",
    name: "Azure Bloom",
    url: "/wallpapers/generated/talome-53.jpg",
  },
  {
    id: "violet-core",
    name: "Violet Core",
    url: "/wallpapers/generated/talome-54.jpg",
  },
  {
    id: "arctic-ember",
    name: "Arctic Ember",
    url: "/wallpapers/generated/talome-55.jpg",
  },
  {
    id: "teal-halo",
    name: "Teal Halo",
    url: "/wallpapers/generated/talome-56.jpg",
  },
  {
    id: "silver-tempest",
    name: "Silver Tempest",
    url: "/wallpapers/generated/talome-57.jpg",
  },
  {
    id: "porcelain-helix",
    name: "Porcelain Helix",
    url: "/wallpapers/generated/talome-63.jpg",
  },
  {
    id: "mist-genome",
    name: "Mist Genome",
    url: "/wallpapers/generated/talome-64.jpg",
  },
  {
    id: "coral-strand",
    name: "Coral Strand",
    url: "/wallpapers/generated/talome-65.jpg",
  },
  {
    id: "dusk-ribbon",
    name: "Dusk Ribbon",
    url: "/wallpapers/generated/talome-66.jpg",
  },
  {
    id: "silver-horizon",
    name: "Silver Horizon",
    url: "/wallpapers/generated/talome-67.jpg",
  },
  {
    id: "copper-singularity",
    name: "Copper Singularity",
    url: "/wallpapers/generated/talome-68.jpg",
  },
  {
    id: "polar-thread",
    name: "Polar Thread",
    url: "/wallpapers/generated/talome-69.jpg",
  },
  {
    id: "distant-quasar",
    name: "Distant Quasar",
    url: "/wallpapers/generated/talome-70.jpg",
  },
  {
    id: "gravity-veil",
    name: "Gravity Veil",
    url: "/wallpapers/generated/talome-71.jpg",
  },
  {
    id: "obsidian-halo",
    name: "Obsidian Halo",
    url: "/wallpapers/generated/talome-72.jpg",
  },
  {
    id: "blue-shift",
    name: "Blue Shift",
    url: "/wallpapers/generated/talome-73.jpg",
  },
  {
    id: "quiet-horizon",
    name: "Quiet Horizon",
    url: "/wallpapers/generated/talome-74.jpg",
  },
  {
    id: "pearl-event",
    name: "Pearl Event",
    url: "/wallpapers/generated/talome-75.jpg",
  },
  {
    id: "violet-horizon",
    name: "Violet Horizon",
    url: "/wallpapers/generated/talome-76.jpg",
  },
  {
    id: "amber-drift",
    name: "Amber Drift",
    url: "/wallpapers/generated/talome-77.jpg",
  },
  {
    id: "whispered-lens",
    name: "Whispered Lens",
    url: "/wallpapers/generated/talome-78.jpg",
  },
];

type WallpaperSource = "talome" | "custom";

function isPresetWallpaper(wallpaperUrl?: string): boolean {
  return WALLPAPER_PRESETS.some((preset) => preset.url === wallpaperUrl);
}

function WallpaperImage({
  wallpaperUrl,
  alt,
  sizes,
  className,
}: {
  wallpaperUrl?: string;
  alt: string;
  sizes: string;
  className?: string;
}) {
  return wallpaperUrl ? (
    <Image
      src={wallpaperUrl}
      alt={alt}
      fill
      unoptimized={wallpaperUrl.startsWith("data:")}
      sizes={sizes}
      className={cn("object-cover", className)}
    />
  ) : (
    <span className="flex size-full flex-col items-center justify-center gap-2 bg-card text-muted-foreground">
      <HugeiconsIcon icon={Image01Icon} size={24} strokeWidth={1.4} />
      <span className="text-xs">Talome</span>
    </span>
  );
}

function WallpaperPresetButton({
  preset,
  selected,
  onSelect,
}: {
  preset: WallpaperPreset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`Use ${preset.name} wallpaper`}
      className="group grid min-w-0 gap-2 text-left outline-none"
      onClick={onSelect}
    >
      <span
        className={cn(
          "relative aspect-video overflow-hidden rounded-lg border bg-card transition-[border-color,box-shadow] duration-150",
          selected
            ? "border-foreground/70 ring-2 ring-foreground/25"
            : "border-border/80 group-hover:border-foreground/30 group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
        )}
      >
        <WallpaperImage
          wallpaperUrl={preset.url}
          alt=""
          sizes="140px"
          className="transition-transform duration-150 group-hover:scale-[1.02]"
        />
        {selected ? (
          <span className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm backdrop-blur-sm">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} />
          </span>
        ) : null}
      </span>
      <span className="truncate text-xs text-muted-foreground group-hover:text-foreground">
        {preset.name}
      </span>
    </button>
  );
}

interface DesktopWidgetsPanelProps {
  controller: WidgetLayoutController;
  title: string;
  subtitle: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onBack?: () => void;
}

export function DesktopWidgetsPanel({
  controller,
  title,
  subtitle,
  editing,
  onEditingChange,
  onBack,
}: DesktopWidgetsPanelProps) {
  return (
    <div className="flex h-[min(44rem,calc(100dvh-4rem))] min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-3">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            aria-label="Back to Control Center"
            onClick={onBack}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <Button
          type="button"
          variant={editing ? "secondary" : "ghost"}
          size="sm"
          className="h-8 gap-1.5 px-3 text-xs"
          onClick={() => onEditingChange(!editing)}
        >
          <HugeiconsIcon
            icon={editing ? Tick01Icon : DashboardSquareEditIcon}
            size={14}
          />
          {editing ? "Done" : "Edit"}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ControlledWidgetGrid
          controller={controller}
          editMode={editing}
          compact
        />
      </div>
    </div>
  );
}

/** Whether the wallpaper reached the account (other devices), after it was applied here. */
export type WallpaperAccountSave =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "failed"; retry: () => void };

interface DesktopWallpaperDialogProps {
  open: boolean;
  wallpaperUrl?: string;
  wallpaperAttribution?: DesktopWallpaperAttribution;
  onOpenChange: (open: boolean) => void;
  onWallpaperChange: (
    wallpaperUrl?: string,
    attribution?: DesktopWallpaperAttribution,
  ) => boolean;
  /** Account save state; a failure is shown inline with Retry (the change stays on this browser). */
  accountSave?: WallpaperAccountSave;
}

function DesktopWallpaperPicker({
  wallpaperUrl,
  onOpenChange,
  onWallpaperChange,
  accountSave,
  onTitlebarPointerDown,
}: Omit<DesktopWallpaperDialogProps, "open"> & {
  onTitlebarPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<WallpaperSource>(() => (
    isPresetWallpaper(wallpaperUrl) ? "talome" : "custom"
  ));
  const [error, setError] = useState("");

  const chooseWallpaper = () => {
    setError("");
    setSource("custom");
    inputRef.current?.click();
  };

  const selectWallpaper = (nextWallpaperUrl?: string) => {
    if (!onWallpaperChange(nextWallpaperUrl, undefined)) {
      setError("The wallpaper could not be saved. Try again.");
      return;
    }
    setError("");
  };

  const handleWallpaperFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      setError("Choose an image smaller than 2 MB.");
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        setError("The image could not be read.");
        return;
      }
      if (!onWallpaperChange(reader.result)) {
        setError("The image could not be saved. Try a smaller file.");
        return;
      }
      setSource("custom");
      setError("");
    }, { once: true });
    reader.addEventListener("error", () => {
      setError("The image could not be read.");
    }, { once: true });
    reader.readAsDataURL(file);
  };

  return (
    <>
      <header
        data-wallpaper-drag-handle
        className="grid h-11 touch-none cursor-grab select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border/70 px-3 active:cursor-grabbing"
        onPointerDown={onTitlebarPointerDown}
      >
        {/* A dialog, not a window: only the close light, with the window's 28px target
            (no disabled minimize/zoom dots that look like controls but aren't). */}
        <div className="-ml-1.5 flex items-center" role="group" aria-label="Window controls">
          <button
            type="button"
            aria-label="Close Desktop Wallpaper"
            className="group/control relative flex size-7 items-center justify-center rounded-full outline-none before:size-3.5 before:rounded-full before:bg-window-close before:ring-1 before:ring-inset before:ring-window-control-edge focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onOpenChange(false)}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={10}
              strokeWidth={2.5}
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-black/70 opacity-0 transition-opacity duration-100 group-hover/control:opacity-100 group-focus-visible/control:opacity-100"
            />
          </button>
        </div>
        <DialogTitle className="pointer-events-none truncate px-2 text-center text-sm font-medium leading-normal">
          Desktop Wallpaper
        </DialogTitle>
        <DialogDescription className="sr-only">
          Choose a Talome wallpaper or upload a custom image.
        </DialogDescription>
        <span />
      </header>

      <div className="grid gap-4 p-4">
        <Tabs
          value={source}
          onValueChange={(value) => setSource(value as WallpaperSource)}
          className="gap-4"
        >
          <TabsList className="self-center">
            <TabsTab value="talome" className="min-w-20">Talome</TabsTab>
            <TabsTab value="custom" className="min-w-20">Custom</TabsTab>
          </TabsList>

          <TabsPanel value="talome">
            <div
              className="grid max-h-[22rem] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-5"
              role="radiogroup"
              aria-label="Talome wallpapers"
            >
              {WALLPAPER_PRESETS.map((preset) => (
                <WallpaperPresetButton
                  key={preset.id}
                  preset={preset}
                  selected={preset.url === wallpaperUrl}
                  onSelect={() => selectWallpaper(preset.url)}
                />
              ))}
            </div>
          </TabsPanel>

          <TabsPanel value="custom" className="grid gap-3">
            {wallpaperUrl
            && !isPresetWallpaper(wallpaperUrl)
            ? (
              <div className="relative h-36 overflow-hidden rounded-lg border border-border bg-card">
                <WallpaperImage
                  wallpaperUrl={wallpaperUrl}
                  alt="Custom wallpaper preview"
                  sizes="640px"
                />
              </div>
            ) : null}
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-card/45 p-4 text-left transition-colors duration-150 hover:border-foreground/25 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={chooseWallpaper}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <HugeiconsIcon icon={ImageAdd01Icon} size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">Upload Image</span>
                <span className="block text-xs text-muted-foreground">
                  JPG, PNG or WebP · Up to 2 MB
                </span>
              </span>
            </button>
          </TabsPanel>
        </Tabs>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Choose desktop wallpaper image"
          onChange={handleWallpaperFile}
        />
        {error ? (
          <p className="text-sm text-status-critical" role="alert">{error}</p>
        ) : null}
        {accountSave?.status === "failed" ? (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" role="alert">
            <span>Saved on this browser only. Couldn&apos;t save to your account.</span>
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={accountSave.retry}>
              Retry
            </Button>
          </p>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-border/70 px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto"
          disabled={!wallpaperUrl}
          onClick={() => {
            selectWallpaper(undefined);
            setSource("talome");
          }}
        >
          Reset
        </Button>
        <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </footer>
    </>
  );
}

export function DesktopWallpaperDialog({
  open,
  wallpaperUrl,
  wallpaperAttribution,
  onOpenChange,
  onWallpaperChange,
  accountSave,
}: DesktopWallpaperDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<WallpaperDialogPosition>({ x: 0, y: 0 });
  const dragOriginRef = useRef<WallpaperDialogDragOrigin | null>(null);

  useEffect(() => {
    if (!open) {
      positionRef.current = { x: 0, y: 0 };
      dragOriginRef.current = null;
      return;
    }

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const dragOrigin = dragOriginRef.current;
      const content = contentRef.current;
      if (!dragOrigin || !content) return;

      const pointerDeltaX = event.clientX - dragOrigin.pointerX;
      const pointerDeltaY = event.clientY - dragOrigin.pointerY;
      const minimumDeltaX = WALLPAPER_DIALOG_VIEWPORT_MARGIN - dragOrigin.bounds.left;
      const maximumDeltaX = window.innerWidth
        - WALLPAPER_DIALOG_VIEWPORT_MARGIN
        - dragOrigin.bounds.right;
      const minimumDeltaY = WALLPAPER_DIALOG_VIEWPORT_MARGIN - dragOrigin.bounds.top;
      const maximumDeltaY = window.innerHeight
        - WALLPAPER_DIALOG_VIEWPORT_MARGIN
        - dragOrigin.bounds.bottom;
      const nextPosition = {
        x: dragOrigin.position.x + Math.min(
          maximumDeltaX,
          Math.max(minimumDeltaX, pointerDeltaX),
        ),
        y: dragOrigin.position.y + Math.min(
          maximumDeltaY,
          Math.max(minimumDeltaY, pointerDeltaY),
        ),
      };

      positionRef.current = nextPosition;
      content.style.translate = `calc(-50% + ${nextPosition.x}px) calc(-50% + ${nextPosition.y}px)`;
    };

    const handlePointerUp = () => {
      dragOriginRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      dragOriginRef.current = null;
    };
  }, [open]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const content = contentRef.current;
    if (event.button !== 0 || !content) return;

    event.preventDefault();
    dragOriginRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      position: positionRef.current,
      bounds: content.getBoundingClientRect(),
    };
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        data-wallpaper-dialog
        className="z-[1500] max-h-[calc(100dvh-3rem)] gap-0 overflow-y-auto rounded-xl p-0 sm:max-w-2xl"
        overlayClassName="z-[1450]"
        showCloseButton={false}
      >
        <DesktopWallpaperPicker
          wallpaperUrl={wallpaperUrl}
          wallpaperAttribution={wallpaperAttribution}
          onOpenChange={onOpenChange}
          onWallpaperChange={onWallpaperChange}
          accountSave={accountSave}
          onTitlebarPointerDown={startDrag}
        />
      </DialogContent>
    </Dialog>
  );
}
