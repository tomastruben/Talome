"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  HugeiconsIcon,
  Globe02Icon,
  Share04Icon,
  Cancel01Icon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { getHostUrl } from "@/lib/constants";
import { useQuickLook } from "./quick-look-context";
import type { Container } from "@talome/types";

// ── Port picker — if multiple TCP ports, let user switch between them ──────────

function PortPicker({
  ports,
  active,
  onChange,
}: {
  ports: number[];
  active: number;
  onChange: (p: number) => void;
}) {
  if (ports.length <= 1) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {ports.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={cn(
            "flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-md transition-colors",
            p === active
              ? "bg-foreground/10 text-foreground"
              : "text-dim-foreground hover:text-muted-foreground hover:bg-foreground/5"
          )}
        >
          <HugeiconsIcon icon={Globe02Icon} size={10} />
          {p}
        </button>
      ))}
    </div>
  );
}

// ── Main QuickLook component ──────────────────────────────────────────────────

function QuickLookContent({ container }: { container: Container }) {
  const { close } = useQuickLook();

  const tcpPorts = container.ports
    .filter((p) => p.protocol === "tcp" && p.host > 0)
    .map((p) => p.host)
    .filter((p, i, arr) => arr.indexOf(p) === i);

  const [activePort, setActivePort] = useState<number | null>(tcpPorts[0] ?? null);
  const [iframeState, setIframeState] = useState<"loading" | "ready" | "blocked">("loading");
  const [iframeKey, setIframeKey] = useState(0);

  // Reset when port changes
  useEffect(() => {
    setIframeState("loading");
    setIframeKey((k) => k + 1);
  }, [activePort]);

  const activeUrl = activePort ? getHostUrl(activePort) : null;

  const handlePortChange = useCallback((p: number) => {
    setActivePort(p);
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [close]);

  const isRunning = container.status === "running";

  return (
    <div className="flex flex-col h-full">
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex h-12 items-center gap-2 px-3 border-b border-border shrink-0">
        {/* Status + name */}
        <span className="relative flex size-1.5 shrink-0">
          {isRunning && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-healthy/60 opacity-75" />
          )}
          <span
            className={cn(
              "relative inline-flex size-1.5 rounded-full",
              isRunning ? "bg-status-healthy" : "bg-muted-foreground/30"
            )}
          />
        </span>
        <span className="font-medium text-sm text-muted-foreground truncate">
          {container.name}
        </span>
        <span className="text-xs text-muted-foreground font-mono truncate hidden sm:block">
          {container.image}
        </span>

        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* Port picker */}
          <PortPicker ports={tcpPorts} active={activePort ?? 0} onChange={handlePortChange} />

          {/* Open in new tab */}
          {activeUrl && (
            <a
              href={activeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-foreground/5"
            >
              Open
              <HugeiconsIcon icon={Share04Icon} size={12} />
            </a>
          )}

          {/* Close */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-dim-foreground hover:text-foreground"
            onClick={close}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </Button>
        </div>
      </div>

      {/* ── Preview area ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative overflow-hidden bg-background">
        {!isRunning || !activeUrl ? (
          // Not running / no port
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
            <span
              className={cn(
                "inline-flex size-2 rounded-full",
                container.status === "stopped" || container.status === "exited"
                  ? "bg-status-critical/40"
                  : "bg-status-warning/40"
              )}
            />
            <p className="text-sm text-muted-foreground capitalize">
              {container.status === "running" ? "No web interface" : container.status}
            </p>
            {(container.status === "stopped" || container.status === "exited") && (
              <p className="text-xs text-muted-foreground">
                Start this container to open its interface.
              </p>
            )}
          </div>
        ) : (
          <>
            {iframeState === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner className="size-5 text-dim-foreground" />
              </div>
            )}
            {iframeState === "blocked" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
                <HugeiconsIcon icon={Globe02Icon} size={32} className="text-dim-foreground" />
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">
                    {container.name} doesn't allow embedding.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This is a security restriction set by the service itself.
                  </p>
                </div>
                <a
                  href={activeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Open {container.name} in new tab
                  <HugeiconsIcon icon={Share04Icon} size={13} />
                </a>
              </div>
            )}
            <iframe
              key={iframeKey}
              src={activeUrl}
              className={cn(
                "w-full h-full border-0 transition-opacity duration-300",
                iframeState === "ready" ? "opacity-100" : "opacity-0"
              )}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              onLoad={() => setIframeState("ready")}
              onError={() => setIframeState("blocked")}
              title={container.name}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Portal-level dialog ───────────────────────────────────────────────────────

export function QuickLookModal() {
  const { container, isOpen, close } = useQuickLook();

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 overflow-hidden w-[calc(100vw-1.5rem)] h-[calc(100svh-1.5rem)] max-w-none! sm:max-w-none! flex flex-col rounded-xl sm:w-[calc(100vw-2.5rem)] sm:h-[calc(100svh-2.5rem)] mt-[env(safe-area-inset-top)]"
      >
        {/* Hidden title satisfies radix accessibility requirement */}
        <DialogTitle className="sr-only">
          {container ? `Quick Look — ${container.name}` : "Quick Look"}
        </DialogTitle>
        <DialogDescription className="sr-only">Container quick look preview</DialogDescription>
        {container && <QuickLookContent container={container} />}
      </DialogContent>
    </Dialog>
  );
}
