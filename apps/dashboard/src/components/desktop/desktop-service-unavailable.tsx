"use client";

import { useState } from "react";
import { HugeiconsIcon, AlertCircleIcon, PackageOpenIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { talomePost } from "@/hooks/use-talome-api";
import type { DesktopServiceState } from "@/lib/desktop-service-state";
import { openPalette } from "@/lib/palette";

export function serviceUnavailableCopy(name: string, state: DesktopServiceState): { title: string; description: string } {
  switch (state) {
    case "stopped":
      return { title: `${name} is stopped`, description: `Start it to open ${name} here.` };
    case "unhealthy":
      return {
        title: `${name} isn't running`,
        description: "It stopped unexpectedly or keeps restarting. Start it again, or ask Talome to find out why.",
      };
    case "missing":
      return {
        title: `${name} isn't installed`,
        description: "No app by this name runs on this server any more. Remove it from the Dock, or install it again from the App Store.",
      };
    default:
      return { title: `${name} can't be opened`, description: "Talome couldn't check whether it is running." };
  }
}

/**
 * What a window shows instead of the browser's error page when its service
 * isn't running (D-P0-3). Start goes through the gated app route for apps
 * Talome installed (the whole stack starts, journaled), and through the
 * container route only for containers Talome doesn't manage.
 */
export function DesktopServiceUnavailable({
  name,
  state,
  startPath,
  canStart,
  onStarted,
  onRemoveFromDock,
  onOpenAppStore,
}: {
  name: string;
  state: DesktopServiceState;
  /** From desktopServiceStartPath(); null when nothing can be started. */
  startPath?: string | null;
  canStart: boolean;
  onStarted: () => Promise<unknown> | void;
  /** Offered for an app that isn't installed any more. */
  onRemoveFromDock?: () => void;
  onOpenAppStore?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = serviceUnavailableCopy(name, state);
  const startable = canStart && startPath && (state === "stopped" || state === "unhealthy");

  const start = async () => {
    if (!startPath) return;
    setBusy(true);
    setError(null);
    try {
      await talomePost(startPath);
      await onStarted();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? `Couldn't start ${name}: ${err.message}`
          : `Couldn't start ${name}. Check Services for details, or ask Talome.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-desktop-service-unavailable={state}
      className="tm-window-content flex size-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <HugeiconsIcon
        icon={state === "missing" ? PackageOpenIcon : AlertCircleIcon}
        size={32}
        className={state === "unhealthy" ? "text-status-critical" : "text-dim-foreground"}
        aria-hidden="true"
      />
      <div className="grid max-w-sm gap-1">
        <p className="text-sm font-medium text-foreground">{copy.title}</p>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      {error ? <p role="alert" className="max-w-sm text-sm text-status-critical">{error}</p> : null}
      <div className="flex gap-2">
        {startable ? (
          <Button size="sm" busy={busy} busyLabel={`Starting ${name}…`} onClick={() => void start()}>
            Start {name}
          </Button>
        ) : null}
        {state === "missing" && onOpenAppStore ? (
          <Button size="sm" onClick={onOpenAppStore}>Open App Store</Button>
        ) : null}
        {state === "missing" && onRemoveFromDock ? (
          <Button size="sm" variant="outline" onClick={onRemoveFromDock}>Remove from Dock</Button>
        ) : null}
        {state !== "missing" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openPalette({
              mode: "chat",
              prefill: `${name} ${state === "stopped" ? "is stopped" : "isn't running properly"}. Find out why and suggest a fix. Ask before changing anything.`,
            })}
          >
            Ask Talome
          </Button>
        ) : null}
      </div>
    </div>
  );
}
