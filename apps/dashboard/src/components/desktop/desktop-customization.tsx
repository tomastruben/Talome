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

const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  { id: "default", name: "Talome" },
  { id: "alpenglow", name: "Alpenglow", url: "/wallpapers/alpenglow.jpg" },
  { id: "aurora", name: "Aurora", url: "/wallpapers/aurora.jpg" },
  { id: "forest", name: "Misty Forest", url: "/wallpapers/misty-forest.jpg" },
  { id: "dune", name: "Dune", url: "/wallpapers/dune.jpg" },
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
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onBack?: () => void;
}

export function DesktopWidgetsPanel({
  controller,
  editing,
  onEditingChange,
  onBack,
}: DesktopWidgetsPanelProps) {
  const visibleWidgetCount = controller.layout.filter((widget) => widget.visible).length;

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
          <h2 className="text-base font-medium">Widgets</h2>
          <p className="text-xs text-muted-foreground">
            {visibleWidgetCount} shown on Desktop
          </p>
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

interface DesktopWallpaperDialogProps {
  open: boolean;
  wallpaperUrl?: string;
  onOpenChange: (open: boolean) => void;
  onWallpaperChange: (wallpaperUrl?: string) => boolean;
}

function DesktopWallpaperPicker({
  wallpaperUrl,
  onOpenChange,
  onWallpaperChange,
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
    if (!onWallpaperChange(nextWallpaperUrl)) {
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
        <div className="flex items-center gap-2" aria-label="Window controls">
          <button
            type="button"
            aria-label="Close Desktop Wallpaper"
            className="group/control flex size-3.5 items-center justify-center rounded-full bg-status-critical/70 transition-colors duration-150 hover:bg-status-critical"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onOpenChange(false)}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={8}
              strokeWidth={2}
              className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
            />
          </button>
          <span className="size-3.5 rounded-full bg-status-warning/70" aria-hidden="true" />
          <span className="size-3.5 rounded-full bg-status-healthy/70" aria-hidden="true" />
        </div>
        <DialogTitle className="pointer-events-none truncate px-2 text-center text-sm font-medium leading-normal">
          Desktop Wallpaper
        </DialogTitle>
        <span />
      </header>

      <div className="grid gap-4 p-4">
        <Tabs
          value={source}
          onValueChange={(value) => setSource(value as WallpaperSource)}
          className="gap-4"
        >
          <TabsList className="self-center">
            <TabsTab value="talome" className="min-w-24">Talome</TabsTab>
            <TabsTab value="custom" className="min-w-24">Custom</TabsTab>
          </TabsList>

          <TabsPanel value="talome">
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-5"
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
            {wallpaperUrl && !isPresetWallpaper(wallpaperUrl) ? (
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
  onOpenChange,
  onWallpaperChange,
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
          onOpenChange={onOpenChange}
          onWallpaperChange={onWallpaperChange}
          onTitlebarPointerDown={startDrag}
        />
      </DialogContent>
    </Dialog>
  );
}
