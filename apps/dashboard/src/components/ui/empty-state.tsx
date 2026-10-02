import type { ReactNode } from "react";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * `fill` drops the dashed card and takes the rest of the view instead,
 * centred: for a state that *is* the view (an empty folder, a failed list) in
 * a window or page whose parent is a flex column filling its height (page
 * roots `flex min-w-0 flex-1 flex-col`, fill-mode lists `flex min-h-full
 * flex-col`). Without it the state is a dashed card sized to its content.
 */
const frame = (fill: boolean | undefined) =>
  fill
    ? "flex min-h-64 flex-1 self-stretch flex-col items-center justify-center gap-3 border-0 p-12 text-center"
    : "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-center";

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  icon?: IconSvgElement;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Fill the parent flex column, centred, without the dashed card */
  fill?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, description, action, fill, className }: EmptyStateProps) {
  return (
    <div data-slot="empty-state" className={cn(frame(fill), className)}>
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
  /** Fill the parent flex column, centred, without the dashed card */
  fill?: boolean;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "Check that the Talome server is reachable.",
  onRetry,
  fill,
  className,
}: ErrorStateProps) {
  return (
    <div data-slot="error-state" className={cn(frame(fill), className)}>
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
        // The only action on every error screen: a 44px target on touch
        <Button variant="ghost" size="sm" onClick={onRetry} className="mt-1 h-7 text-xs pointer-coarse:h-11 pointer-coarse:px-4">
          Retry
        </Button>
      )}
    </div>
  );
}
