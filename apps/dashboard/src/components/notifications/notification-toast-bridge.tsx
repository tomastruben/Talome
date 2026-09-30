"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toastWarning } from "@/lib/toast";
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

export interface ToastBridgeState {
  /** Set once the first successful load has been seen (an empty list counts). */
  initialized: boolean;
  seenIds: Set<number>;
}

/**
 * Which notifications to toast now. The first successful load only seeds
 * what already exists, so old notifications never toast on page load. An
 * empty first load still counts as the seed: before this, the bridge waited
 * for a non-empty list, so the first notification that ever arrived (often
 * a critical one) was swallowed as "already there". Mutates `state`.
 */
export function planNotificationToasts<T extends Pick<AppNotification, "id" | "read">>(
  state: ToastBridgeState,
  notifications: readonly T[],
  loaded: boolean,
): T[] {
  if (!loaded) return [];
  if (!state.initialized) {
    for (const n of notifications) state.seenIds.add(n.id);
    state.initialized = true;
    return [];
  }
  const fresh: T[] = [];
  for (const n of notifications) {
    if (state.seenIds.has(n.id)) continue;
    state.seenIds.add(n.id);
    if (!n.read) fresh.push(n);
  }
  return fresh;
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
  const { notifications, isMuted, isLoaded } = useNotifications({ poll: true });
  const { isAdmin } = useUser();
  const router = useRouter();
  const state = useRef<ToastBridgeState>({ initialized: false, seenIds: new Set() });

  useEffect(() => {
    const fresh = planNotificationToasts(state.current, notifications, isLoaded);
    // Muted: arrivals are still marked seen, so unmuting doesn't replay them.
    if (isMuted) return;
    for (const n of fresh) showToast(n, { isAdmin }, (href) => router.push(href));
  }, [notifications, isLoaded, isMuted, isAdmin, router]);

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
      toastWarning(n.title, {
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
