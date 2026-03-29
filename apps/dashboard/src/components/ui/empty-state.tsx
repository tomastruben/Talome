import type { ReactNode } from "react";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: IconSvgElement;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-center",
        className
      )}
    >
      {icon && (
        <HugeiconsIcon
          icon={icon}
          size={32}
          className="text-dim-foreground"
          strokeWidth={1.5}
        />
      )}
      <div className="grid gap-1">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ── ErrorState ────────────────────────────────────────────────────────────────

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "Check that the Talome server is reachable.",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-center",
        className
      )}
    >
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={32}
        className="text-destructive/40"
        strokeWidth={1.5}
      />
      <div className="grid gap-1">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry} className="mt-1 h-7 text-xs">
          Try again
        </Button>
      )}
    </div>
  );
}
