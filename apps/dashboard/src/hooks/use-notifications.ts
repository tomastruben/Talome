"use client";

import useSWR, { mutate } from "swr";
import { useCallback, useRef } from "react";
import { CORE_URL } from "@/lib/constants";
import { APPROVALS_PATH, approvalHref } from "@/components/trust/format";

export interface AppNotification {
  id: number;
  type: "info" | "warning" | "critical";
  title: string;
  body: string;
  read: boolean;
  sourceId: string | null;
  createdAt: string;
  /** Where the notification's action leads (newer cores; optional). */
  link?: string | null;
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const LIST_KEY = `${CORE_URL}/api/notifications?limit=30`;
const COUNT_KEY = `${CORE_URL}/api/notifications/unread-count`;
const MUTE_KEY = `${CORE_URL}/api/notifications/mute-status`;

function getConciseFailureBody(body: string): string {
  const normalized = body.toLowerCase();

  if (
    normalized.includes("variable is not set") ||
    normalized.includes("defaulting to a blank string")
  ) {
    return "Config values are missing. Check environment settings.";
  }

  if (
    normalized.includes("docker compose") ||
    normalized.includes("command failed") ||
    normalized.includes("non-zero exit")
  ) {
    return "Setup command failed. Open logs for details.";
  }

  return "Setup failed. Open logs for details.";
}

function formatNotificationBody(notification: AppNotification): string {
  const body = notification.body?.trim();
  if (!body) return "";

  if (notification.type !== "critical") {
    return body.length > 140 ? `${body.slice(0, 137)}...` : body;
  }

  const title = notification.title.toLowerCase();
  const isInstallOrUpdateFailure =
    title.startsWith("failed to install") || title.startsWith("failed to update");

  if (isInstallOrUpdateFailure) {
    return getConciseFailureBody(body);
  }

  return body.length > 120 ? `${body.slice(0, 117)}...` : body;
}

function formatNotificationTitle(notification: AppNotification): string {
  const title = notification.title.trim();
  const installMatch = /^failed to install\s+(.+)$/i.exec(title);
  if (installMatch) return `${installMatch[1]} install failed`;

  const updateMatch = /^failed to update\s+(.+)$/i.exec(title);
  if (updateMatch) return `${updateMatch[1]} update failed`;

  return title;
}

export interface NotificationAction {
  href: string;
  label: string;
  /** Absolute http(s) URL — open in a new tab instead of client navigation. */
  external: boolean;
}

/** Who is looking at the notification. Approvals can only be reviewed by admins. */
export interface NotificationViewer {
  isAdmin: boolean;
}

type ActionableNotification = Pick<AppNotification, "title" | "body" | "sourceId"> & {
  link?: string | null;
  fullBody?: string;
};

const APPROVAL_REF = /approval:([A-Za-z0-9_-]{1,128})/;

/** A same-origin path ("/dashboard/…"), never protocol-relative ("//host") or a backslash trick. */
function isSafeInternalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function approvalReference(n: ActionableNotification): string | null {
  const match =
    APPROVAL_REF.exec(n.sourceId ?? "") ?? APPROVAL_REF.exec(n.title) ?? APPROVAL_REF.exec(n.fullBody ?? n.body ?? "");
  return match ? match[1] : null;
}

function notificationLink(n: ActionableNotification): string {
  return typeof n.link === "string" ? n.link.trim() : "";
}

function isApprovalsPath(link: string): boolean {
  return link.startsWith(APPROVALS_PATH);
}

/** True for an "Approval needed" notification (links to, or references, an approval). */
export function isApprovalNotification(n: ActionableNotification): boolean {
  const link = notificationLink(n);
  return (isSafeInternalPath(link) && isApprovalsPath(link)) || approvalReference(n) !== null;
}

/**
 * The clickable action for a notification: its `link` when the server sent
 * one, else — for approval notifications written before `link` existed — the
 * approvals page for the `approval:<id>` reference in its source or text.
 * Returns null when there is nothing safe to link to.
 *
 * The approvals page is admin-only, so members get no approval action at all
 * (it would only bounce them to the Settings index).
 */
export function getNotificationAction(
  n: ActionableNotification,
  viewer: NotificationViewer,
): NotificationAction | null {
  const approvalLabel = "Review approval";

  const link = notificationLink(n);
  if (link) {
    if (isSafeInternalPath(link)) {
      if (isApprovalsPath(link)) return viewer.isAdmin ? { href: link, label: approvalLabel, external: false } : null;
      return { href: link, label: "Open", external: false };
    }
    if (isSafeExternalUrl(link)) return { href: link, label: "Open link", external: true };
  }

  const approvalId = approvalReference(n);
  if (approvalId && viewer.isAdmin) {
    return { href: approvalHref(approvalId), label: approvalLabel, external: false };
  }
  return null;
}

/**
 * Build the navigation target for a notification click.
 * View-only events go to a dashboard page; actionable events go to the
 * assistant with a prompt that explains the situation and asks before acting.
 */
export function getNotificationRoute(n: AppNotification, viewer: NotificationViewer): string {
  const action = getNotificationAction(n, viewer);
  if (action && !action.external) return action.href;

  const t = n.title.toLowerCase();
  const s = n.sourceId;

  // --- View-only pages (no action needed) ---
  if (t.includes("optimiz")) return "/dashboard/media";
  if (t.includes("container") || s === "docker-events") return "/dashboard/containers";
  if (t.includes("cpu") || t.includes("memory") || t.includes("disk")) return "/dashboard";
  if (
    t.includes("improved itself") ||
    t.includes("autofix") ||
    t.includes("rebuilt") ||
    t.includes("evolution")
  )
    return "/dashboard/intelligence";
  if (s === "agent-loop") return "/dashboard/intelligence";

  // Successful app lifecycle → view the app page
  if (
    s &&
    s !== "docker-events" &&
    s !== "agent-loop" &&
    !t.includes("failed") &&
    !t.includes("warning") &&
    !t.includes("permission") &&
    (t.includes("installed") || t.includes("updated") || t.includes("rolled back"))
  )
    return `/dashboard/apps/${s}`;

  // Successful backup → view backups page
  if (t.includes("backup") && !t.includes("failed")) return "/dashboard/backups";

  // --- Actionable / unknown → assistant (always ask before acting) ---
  return assistantPromptUrl(n);
}

function assistantPromptUrl(n: AppNotification): string {
  const body = n.body ? ` — ${n.body}` : "";
  const prompt = `I'd like to understand this notification: "${n.title}"${body}. Please explain what happened and what my options are. Do not take any action unless I explicitly ask you to.`;
  return `/dashboard/assistant?prompt=${encodeURIComponent(prompt)}`;
}

/** Poll cadence of the notification list (the only polled notification key). */
export const NOTIFICATIONS_POLL_MS = 15_000;
/**
 * Safety refresh for the unread count. The count is normally refreshed when
 * the polled list changes; this cheap poll also catches changes outside the
 * top-N list (read/dismissed on another device, bulk cleanup).
 */
export const NOTIFICATIONS_COUNT_SAFETY_MS = 60_000;
export const NOTIFICATIONS_MUTE_POLL_MS = 60_000;

/**
 * Signature of the fields that affect the unread count. When it changes
 * between two list polls, the count is refetched — so the count endpoint no
 * longer needs its own 15s poll.
 */
export function notificationListSignature(list: AppNotification[] | undefined): string {
  if (!Array.isArray(list)) return "";
  return list.map((n) => `${n.id}:${n.read ? 1 : 0}`).join(",");
}

export interface UseNotificationsOptions {
  /**
   * Exactly one mounted instance (NotificationToastBridge in the dashboard
   * shell) owns polling; every other consumer reads the shared SWR cache and
   * never starts timers of its own. Default false.
   */
  poll?: boolean;
}

export function getNotificationSWROptions(poll: boolean) {
  return {
    list: { refreshInterval: poll ? NOTIFICATIONS_POLL_MS : 0 },
    count: {
      refreshInterval: poll ? NOTIFICATIONS_COUNT_SAFETY_MS : 0,
      revalidateOnFocus: false,
    },
    mute: { refreshInterval: poll ? NOTIFICATIONS_MUTE_POLL_MS : 0 },
  } as const;
}

export function useNotifications(options: UseNotificationsOptions = {}) {
  const { poll = false } = options;
  const swrOptions = getNotificationSWROptions(poll);
  const lastSignatureRef = useRef<string | null>(null);

  const { data, isLoading } = useSWR<AppNotification[]>(
    LIST_KEY,
    fetcher,
    {
      ...swrOptions.list,
      onSuccess: (list) => {
        if (!poll) return;
        const signature = notificationListSignature(list);
        const previous = lastSignatureRef.current;
        lastSignatureRef.current = signature;
        // New / read / dismissed notifications → refresh the unread count.
        if (previous !== null && previous !== signature) void mutate(COUNT_KEY);
      },
    }
  );

  const { data: countData } = useSWR<{ count: number }>(
    COUNT_KEY,
    fetcher,
    swrOptions.count
  );

  const { data: muteData } = useSWR<{ muted: boolean }>(
    MUTE_KEY,
    fetcher,
    swrOptions.mute
  );

  // Prevent rapid-fire dismiss calls for the same ID
  const dismissingIds = useRef(new Set<number>());

  const markRead = useCallback(async (id: number) => {
    // Optimistic: mark as read locally
    mutate(
      LIST_KEY,
      (current: AppNotification[] | undefined) =>
        current?.map((n) => (n.id === id ? { ...n, read: true } : n)),
      false,
    );
    mutate(
      COUNT_KEY,
      (current: { count: number } | undefined) =>
        current ? { count: Math.max(0, current.count - 1) } : current,
      false,
    );

    try {
      const res = await fetch(`${CORE_URL}/api/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      // Rollback on failure
      mutate(LIST_KEY);
      mutate(COUNT_KEY);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    // Optimistic: mark all as read locally
    mutate(
      LIST_KEY,
      (current: AppNotification[] | undefined) =>
        current?.map((n) => ({ ...n, read: true })),
      false,
    );
    mutate(COUNT_KEY, { count: 0 }, false);

    try {
      const res = await fetch(`${CORE_URL}/api/notifications/read-all`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      mutate(LIST_KEY);
      mutate(COUNT_KEY);
    }
  }, []);

  const dismiss = useCallback(async (id: number) => {
    if (dismissingIds.current.has(id)) return;
    dismissingIds.current.add(id);

    // Optimistic: remove from list locally
    const previousList = data;
    const previousCount = countData;

    mutate(
      LIST_KEY,
      (current: AppNotification[] | undefined) =>
        current?.filter((n) => n.id !== id),
      false,
    );
    mutate(
      COUNT_KEY,
      (current: { count: number } | undefined) => {
        const removed = previousList?.find((n) => n.id === id);
        if (current && removed && !removed.read) {
          return { count: Math.max(0, current.count - 1) };
        }
        return current;
      },
      false,
    );

    try {
      const res = await fetch(`${CORE_URL}/api/notifications/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      // Rollback on failure — restore previous data
      mutate(LIST_KEY, previousList, false);
      mutate(COUNT_KEY, previousCount, false);
    } finally {
      dismissingIds.current.delete(id);
    }
  }, [data, countData]);

  const toggleMute = useCallback(async () => {
    const currentMuted = muteData?.muted ?? false;
    const newMuted = !currentMuted;

    // Optimistic
    mutate(MUTE_KEY, { muted: newMuted }, false);

    try {
      const res = await fetch(`${CORE_URL}/api/notifications/toggle-mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muted: newMuted }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      mutate(MUTE_KEY, { muted: currentMuted }, false);
    }
  }, [muteData]);

  const list = Array.isArray(data)
    ? data.map((notification) => ({
        ...notification,
        title: formatNotificationTitle(notification),
        body: formatNotificationBody(notification),
        fullBody: notification.body?.trim() ?? "",
      }))
    : [];

  return {
    notifications: list,
    unreadCount: countData?.count ?? 0,
    hasCritical: list.some((n) => !n.read && n.type === "critical"),
    isMuted: muteData?.muted ?? false,
    isLoading,
    /** True once the list has loaded successfully (an empty list counts). */
    isLoaded: Array.isArray(data),
    markRead,
    markAllRead,
    dismiss,
    toggleMute,
  };
}
