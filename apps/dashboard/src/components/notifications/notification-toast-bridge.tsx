"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { useNotifications, type AppNotification } from "@/hooks/use-notifications";

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
  const { notifications, isMuted } = useNotifications();
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

      showToast(n);
    }
  }, [notifications, isMuted]);

  return null;
}

function showToast(n: AppNotification) {
  const body = n.body ? renderInlineBold(n.body) : undefined;

  switch (n.type) {
    case "critical":
      toast.error(n.title, {
        description: body,
        duration: Infinity,
      });
      break;

    case "warning":
      toast.warning(n.title, {
        description: body,
        duration: 8000,
      });
      break;

    case "info":
      // Info stays in the bell — no toast.
      break;
  }
}
