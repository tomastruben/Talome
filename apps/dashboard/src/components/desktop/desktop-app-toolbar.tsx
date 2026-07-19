"use client";

import type { ComponentProps } from "react";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { cn } from "@/lib/utils";

export function DesktopAppToolbar({
  className,
  ...props
}: ComponentProps<"div">) {
  const embeddedFrame = useIsEmbeddedFrame();

  return (
    <div
      data-desktop-app-toolbar={embeddedFrame ? "true" : undefined}
      className={cn(
        className,
        embeddedFrame && "sticky -top-4 z-20 -mx-4 -mt-4 border-b border-border/70 bg-background/90 px-4 py-3 backdrop-blur-md",
      )}
      {...props}
    />
  );
}
