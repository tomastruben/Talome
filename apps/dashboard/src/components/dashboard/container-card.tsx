"use client";

import { HugeiconsIcon, Globe02Icon } from "@/components/icons";
import { getHostUrl } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { Container } from "@talome/types";

interface ContainerCardProps {
  container: Container;
  /** "row" uses flat padding with no border — for use inside a divided list widget */
  variant?: "card" | "row";
  /** Called when the user taps a port chip. If not provided, opens URL in new tab. */
  onPortClick?: (container: Container, port: number) => void;
}

export function ContainerCard({ container, variant = "card", onPortClick }: ContainerCardProps) {
  const isRunning = container.status === "running";
  const ports = container.ports
    .filter((p) => p.protocol === "tcp" && p.host > 0)
    .map((p) => p.host)
    .filter((p, i, arr) => arr.indexOf(p) === i);

  return (
    <div
      className={cn(
        "flex items-center gap-3 min-w-0",
        variant === "card"
          ? "rounded-lg border px-4 py-3"
          : "px-4 py-2.5"
      )}
    >
      <span className="status-dot shrink-0" data-status={container.status} role="img" aria-label={`Status: ${container.status}`} />

      <div className="flex-1 min-w-0">
        <p className="container-name">{container.name}</p>
        <p className="container-image">{container.image}</p>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {isRunning && ports.slice(0, 2).map((port) =>
          onPortClick ? (
            <button
              key={port}
              type="button"
              className="port-chip"
              onClick={(e) => { e.stopPropagation(); onPortClick(container, port); }}
            >
              <HugeiconsIcon icon={Globe02Icon} size={11} />
              {port}
            </button>
          ) : (
            <a
              key={port}
              href={getHostUrl(port)}
              target="_blank"
              rel="noopener noreferrer"
              className="port-chip"
              onClick={(e) => e.stopPropagation()}
            >
              <HugeiconsIcon icon={Globe02Icon} size={11} />
              {port}
            </a>
          )
        )}
        {container.stats && (
          <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
            {container.stats.cpuPercent.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
