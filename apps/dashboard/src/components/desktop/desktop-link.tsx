"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";

type DesktopLinkProps = ComponentProps<typeof Link>;

export function DesktopLink({ onClick, ...props }: DesktopLinkProps) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return;

        if (requestDesktopNavigation(event.currentTarget.href)) {
          event.preventDefault();
        }
      }}
    />
  );
}
