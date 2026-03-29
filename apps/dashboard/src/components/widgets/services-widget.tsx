"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import {
  AlertCircleIcon,
  HugeiconsIcon,
  PackageOpenIcon,
  Package01Icon,
  Layers01Icon,
  ArrowDown01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList, WidgetListSkeleton, WidgetListState } from "./list-widget";
import { cn } from "@/lib/utils";
import type { Container, ServiceStack } from "@talome/types";

// ── Icon with status badge ───────────────────────────────────────────────────

function ServiceIcon({ url, icon, size = "md" }: { url: string; icon?: string; size?: "sm" | "md" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={size === "sm" ? "text-xs" : "text-sm"}>{icon || "📦"}</span>;
  return (
    <Image
      src={url}
      alt=""
      role="presentation"
      className="object-cover"
      fill
      onError={() => setFailed(true)}
    />
  );
}

function StatusIcon({
  iconUrl,
  icon,
  fallbackIcon,
  status,
  size = "md",
}: {
  iconUrl?: string | null;
  icon?: string;
  fallbackIcon?: typeof Package01Icon;
  status: "running" | "partial" | "stopped" | string;
  size?: "sm" | "md";
}) {
  const realUrl = iconUrl && !iconUrl.startsWith("file://") ? iconUrl : null;
  const FallbackIcon = fallbackIcon ?? Package01Icon;
  const sizeClass = size === "sm" ? "size-5 rounded-md" : "size-7 rounded-lg";
  const iconSize = size === "sm" ? 10 : 14;
  const badgeSize = size === "sm" ? "size-1.5" : "size-2";
  const statusColor =
    status === "running" ? "bg-status-healthy"
    : status === "partial" ? "bg-status-warning"
    : "bg-muted-foreground/35";

  return (
    <div className={cn("relative shrink-0", size === "sm" ? "size-5" : "size-7")}>
      <div className={cn(
        "relative bg-muted/50 border border-border/30 flex items-center justify-center overflow-hidden",
        sizeClass,
      )}>
        {realUrl ? (
          <ServiceIcon url={realUrl} icon={icon} size={size} />
        ) : icon && icon !== "📦" ? (
          <span className={size === "sm" ? "text-xs" : "text-sm"}>{icon}</span>
        ) : (
          <HugeiconsIcon icon={FallbackIcon} size={iconSize} className="text-dim-foreground" />
        )}
      </div>
      <span className={cn(
        "absolute -bottom-0.5 -right-0.5 rounded-full border border-card",
        badgeSize, statusColor,
      )} />
    </div>
  );
}

// ── Port badge ───────────────────────────────────────────────────────────────

function PortBadge({
  port,
  onClick,
}: {
  port: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Open port ${port}`}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(e as unknown as React.MouseEvent); }}
      className="text-xs text-muted-foreground hover:text-foreground tabular-nums transition-colors cursor-pointer"
    >
      :{port}
    </span>
  );
}

function getWebPorts(container: Container): number[] {
  return container.ports
    .filter((p) => p.protocol === "tcp" && p.host > 0)
    .map((p) => p.host)
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .slice(0, 3);
}

// ── Stack row ────────────────────────────────────────────────────────────────

function StackRow({
  stack,
  quickLook,
}: {
  stack: ServiceStack;
  quickLook: ReturnType<typeof useQuickLook>;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMulti = stack.containers.length > 1;
  const primaryPorts = getWebPorts(stack.primaryContainer);
  const primaryRunning = stack.primaryContainer.status === "running";
  const FallbackIcon = stack.kind === "compose" && isMulti ? Layers01Icon : Package01Icon;

  const handleClick = () => {
    if (isMulti) {
      setExpanded((v) => !v);
    } else if (primaryRunning && primaryPorts.length > 0) {
      quickLook.open(stack.primaryContainer);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className="w-full px-3 py-2 text-left transition-colors hover:bg-muted/25 flex items-center gap-2.5 min-w-0"
      >
        <StatusIcon
          iconUrl={stack.iconUrl}
          icon={stack.icon}
          fallbackIcon={FallbackIcon}
          status={stack.status}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{stack.name}</p>
          {isMulti && (
            <p className="text-xs text-muted-foreground leading-tight">
              {stack.runningCount}/{stack.totalCount} running
            </p>
          )}
        </div>
        {/* Ports for single-container stacks */}
        {!isMulti && primaryPorts.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            {primaryPorts.map((port) => (
              <PortBadge
                key={port}
                port={port}
                onClick={(e) => {
                  e.stopPropagation();
                  quickLook.open(stack.primaryContainer);
                }}
              />
            ))}
          </div>
        )}
        {stack.memoryUsageMb > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {stack.memoryUsageMb < 1024
              ? `${Math.round(stack.memoryUsageMb)}M`
              : `${(stack.memoryUsageMb / 1024).toFixed(1)}G`}
          </span>
        )}
        {isMulti && (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            className={cn(
              "text-dim-foreground shrink-0 transition-transform duration-150",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>

      {/* Expanded child containers */}
      {isMulti && expanded && (
        <div className="bg-muted/10 border-t border-border/20">
          {stack.containers.map((container) => {
            const ci = stack.containerIcons?.[container.id];
            const ports = getWebPorts(container);
            const isRunning = container.status === "running";
            return (
              <div
                key={container.id}
                className="flex items-center gap-2 px-3 py-1.5 pl-6 min-w-0"
              >
                <StatusIcon
                  iconUrl={ci?.iconUrl}
                  icon={ci?.icon}
                  status={container.status}
                  size="sm"
                />
                <span className="text-sm text-muted-foreground truncate flex-1">
                  {ci?.name ?? container.name}
                </span>
                {ports.length > 0 && (
                  <div className="flex items-center gap-1 shrink-0">
                    {ports.map((port) => (
                      <PortBadge
                        key={port}
                        port={port}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRunning) quickLook.open(container);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function ServicesWidget() {
  const { stacks, isLoading, error, refresh } = useServiceStacks();
  const { handleSubmit } = useAssistant();
  const quickLook = useQuickLook();
  const router = useRouter();

  const askTalome = useCallback(() => {
    void handleSubmit(
      "The Services widget can't load container data from the Talome server. " +
      "Can you check if Docker is accessible and why the containers API might be failing?"
    );
    router.push("/dashboard/assistant");
  }, [handleSubmit, router]);

  const totalContainers = stacks.reduce((sum, s) => sum + s.totalCount, 0);

  return (
    <Widget>
      <WidgetHeader
        title="Services"
        href="/dashboard/containers"
        hrefLabel={!isLoading && stacks.length > 0 ? `${stacks.length} stacks · ${totalContainers}` : "View all"}
      />
      {isLoading ? (
        <WidgetList>
          <WidgetListSkeleton rows={7} />
        </WidgetList>
      ) : error ? (
        <WidgetListState
          icon={AlertCircleIcon}
          message="Couldn't load services. Check Docker availability."
          action={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refresh()}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                Retry
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={askTalome}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                Ask Talome
              </Button>
            </div>
          }
        />
      ) : stacks.length === 0 ? (
        <WidgetListState
          icon={PackageOpenIcon}
          message="No services running."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/dashboard/apps")}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              Browse apps
            </Button>
          }
        />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/30">
            {stacks.map((stack) => (
              <StackRow
                key={stack.id}
                stack={stack}
                quickLook={quickLook}
              />
            ))}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
