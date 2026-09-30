"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  getNotificationAction,
  useNotifications,
  type AppNotification,
  type NotificationViewer,
} from "@/hooks/use-notifications";
import { useUser } from "@/hooks/use-user";

/** Parse **bold** markers into <strong> elements. */
function renderInlineBold(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-medium">{part}</strong> : part,
  );
}

/**
 * Bridges incoming notifications to Sonner toasts based on severity.
 *
 * - critical → persistent toast (stays until dismissed)
 * - warning  → toast that lingers 8s
 * - info     → stays quiet in the bell
 *
 * When notifications are muted, no toasts are shown.
 * Renders nothing — this is a behaviour-only component.
 */
export function NotificationToastBridge() {
  // The always-mounted bridge is the single notifications poller.
  const { notifications, isMuted } = useNotifications({ poll: true });
  const { isAdmin } = useUser();
  const router = useRouter();
  const seenIds = useRef<Set<number>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    if (notifications.length === 0) return;

    // On first load, mark all existing notifications as "seen"
    // so we only toast truly new arrivals.
    if (!initialized.current) {
      for (const n of notifications) {
        seenIds.current.add(n.id);
      }
      initialized.current = true;
      return;
    }

    for (const n of notifications) {
      if (seenIds.current.has(n.id)) continue;
      seenIds.current.add(n.id);

      if (n.read) continue;

      // Suppress toasts when muted
      if (isMuted) continue;

      showToast(n, { isAdmin }, (href) => router.push(href));
    }
  }, [notifications, isMuted, isAdmin, router]);

  return null;
}

function showToast(
  n: AppNotification & { fullBody?: string },
  viewer: NotificationViewer,
  navigate: (href: string) => void,
) {
  const body = n.body ? renderInlineBold(n.body) : undefined;
  const link = getNotificationAction(n, viewer);
  const action = link
    ? {
        label: link.label,
        onClick: () => {
          if (link.external) window.open(link.href, "_blank", "noopener,noreferrer");
          else navigate(link.href);
        },
      }
    : undefined;

  switch (n.type) {
    case "critical":
      toast.error(n.title, {
        description: body,
        duration: Infinity,
        action,
      });
      break;

    case "warning":
      toast.warning(n.title, {
        description: body,
        duration: 8000,
        action,
      });
      break;

    case "info":
      // Info stays in the bell — no toast.
      break;
  }
}
