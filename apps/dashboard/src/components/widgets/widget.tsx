import Link from "next/link";
import { HugeiconsIcon, ArrowRight01Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface WidgetProps {
  children: ReactNode;
  className?: string;
}

interface WidgetHeaderProps {
  title: string;
  href?: string;
  hrefLabel?: string;
  actions?: ReactNode;
}

export function Widget({ children, className }: WidgetProps) {
  return (
    <div className={cn("h-full rounded-xl border border-border bg-card overflow-hidden flex flex-col", className)}>
      {children}
    </div>
  );
}

export function WidgetHeader({ title, href, hrefLabel, actions }: WidgetHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {title}
      </span>
      <div className="flex items-center gap-2">
        {actions}
        {href && (
          <Link
            href={href}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {hrefLabel ?? "View all"}
            <HugeiconsIcon icon={ArrowRight01Icon} size={11} />
          </Link>
        )}
      </div>
    </div>
  );
}
