"use client";

import { useRef, useState, type ChangeEvent } from "react";
import Image from "next/image";
import {
  ArrowLeft01Icon,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ControlledWidgetGrid,
  type WidgetLayoutController,
} from "@/components/widgets/widget-grid";

const MAX_WALLPAPER_BYTES = 2 * 1024 * 1024;

interface DesktopWidgetsPanelProps {
  controller: WidgetLayoutController;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onOpenWallpaper: () => void;
  onBack?: () => void;
}

export function DesktopWidgetsPanel({
  controller,
  editing,
  onEditingChange,
  onOpenWallpaper,
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
          <h2 className="text-base font-medium">Widgets</h2>
          <p className="text-xs text-muted-foreground">Same layout as Home</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label="Change wallpaper"
          onClick={onOpenWallpaper}
        >
          <HugeiconsIcon icon={Image01Icon} size={16} />
        </Button>
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

export function DesktopWallpaperDialog({
  open,
  wallpaperUrl,
  onOpenChange,
  onWallpaperChange,
}: DesktopWallpaperDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  const chooseWallpaper = () => {
    setError("");
    inputRef.current?.click();
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
      setError("");
    }, { once: true });
    reader.addEventListener("error", () => {
      setError("The image could not be read.");
    }, { once: true });
    reader.readAsDataURL(file);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="z-[1500] sm:max-w-xl"
        overlayClassName="z-[1450]"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>Desktop Wallpaper</DialogTitle>
          <DialogDescription>
            Choose an image stored only in this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-card">
          {wallpaperUrl ? (
            <Image
              src={wallpaperUrl}
              alt="Current desktop wallpaper"
              fill
              unoptimized
              sizes="560px"
              className="object-cover"
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <HugeiconsIcon icon={Image01Icon} size={28} strokeWidth={1.4} />
              <span className="text-sm">Talome background</span>
            </div>
          )}
        </div>

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

        <DialogFooter>
          {wallpaperUrl ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onWallpaperChange(undefined);
                setError("");
              }}
            >
              Use Default
            </Button>
          ) : null}
          <Button type="button" onClick={chooseWallpaper}>
            <HugeiconsIcon icon={ImageAdd01Icon} size={16} />
            Choose Image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
