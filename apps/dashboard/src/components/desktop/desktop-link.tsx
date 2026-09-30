"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { requestDesktopNavigation, shouldHandleDesktopLink } from "@/lib/desktop-navigation";

type DesktopLinkProps = ComponentProps<typeof Link>;

export function DesktopLink({ onClick, ...props }: DesktopLinkProps) {
  return (
    <Link
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!shouldHandleDesktopLink(event, event.currentTarget)) return;

        if (requestDesktopNavigation(event.currentTarget.href)) {
          event.preventDefault();
        }
      }}
    />
  );
}
