import type { ComponentProps, ReactNode } from "react";
import { type IconSvgElement, HugeiconsIcon, ArrowDown01Icon, ArrowUp01Icon } from "@/components/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PillProps = ComponentProps<typeof Badge> & {
  themed?: boolean;
};

export const Pill = ({
  variant = "secondary",
  themed = false,
  className,
  ...props
}: PillProps) => (
  <Badge
    className={cn("gap-2 rounded-full px-3 py-1.5 font-normal", className)}
    variant={variant}
    {...props}
  />
);

export type PillAvatarProps = ComponentProps<typeof AvatarImage> & {
  fallback?: string;
};

export const PillAvatar = ({
  fallback,
  className,
  ...props
}: PillAvatarProps) => (
  <Avatar className={cn("-ml-1 h-4 w-4", className)}>
    <AvatarImage {...props} />
    <AvatarFallback>{fallback}</AvatarFallback>
  </Avatar>
);

export type PillButtonProps = ComponentProps<typeof Button>;

export const PillButton = ({ className, ...props }: PillButtonProps) => (
  <Button
    className={cn(
      "-my-2 -mr-2 size-6 rounded-full p-0.5 hover:bg-foreground/5",
      className
    )}
    size="icon"
    variant="ghost"
    {...props}
  />
);

export type PillStatusProps = {
  children: ReactNode;
  className?: string;
};

export const PillStatus = ({
  children,
  className,
  ...props
}: PillStatusProps) => (
  <div
    className={cn(
      "flex items-center gap-2 border-r pr-2 font-medium",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type PillIndicatorProps = {
  variant?: "success" | "error" | "warning" | "info";
  pulse?: boolean;
};

export const PillIndicator = ({
  variant = "success",
  pulse = false,
}: PillIndicatorProps) => (
  <span className="relative flex size-2">
    {pulse && (
      <span
        className={cn(
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
          variant === "success" && "bg-status-healthy",
          variant === "error" && "bg-status-critical",
          variant === "warning" && "bg-status-warning",
          variant === "info" && "bg-status-info"
        )}
      />
    )}
    <span
      className={cn(
        "relative inline-flex size-2 rounded-full",
        variant === "success" && "bg-status-healthy",
        variant === "error" && "bg-status-critical",
        variant === "warning" && "bg-status-warning",
        variant === "info" && "bg-status-info"
      )}
    />
  </span>
);

export type PillDeltaProps = {
  className?: string;
  delta: number;
};

export const PillDelta = ({ className, delta }: PillDeltaProps) => {
  if (!delta) {
    return (
      <span className={cn("block h-px w-3 bg-muted-foreground", className)} />
    );
  }

  if (delta > 0) {
    return (
      <HugeiconsIcon icon={ArrowUp01Icon} size={12} className={cn("text-status-healthy", className)} />
    );
  }

  return <HugeiconsIcon icon={ArrowDown01Icon} size={12} className={cn("text-status-critical", className)} />;
};

export type PillIconProps = {
  icon: IconSvgElement;
  className?: string;
};

export const PillIcon = ({
  icon: Icon,
  className,
  ...props
}: PillIconProps) => (
  <HugeiconsIcon
    icon={Icon}
    size={12}
    className={cn("text-muted-foreground", className)}
    {...props}
  />
);

export type PillAvatarGroupProps = {
  children: ReactNode;
  className?: string;
};

export const PillAvatarGroup = ({
  children,
  className,
  ...props
}: PillAvatarGroupProps) => (
  <div
    className={cn(
      "-space-x-1 flex items-center",
      "[&>*:not(:first-of-type)]:[mask-image:radial-gradient(circle_9px_at_-4px_50%,transparent_99%,white_100%)]",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
