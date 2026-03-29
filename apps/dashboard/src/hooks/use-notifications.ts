"use client";

import useSWR, { mutate } from "swr";
import { useCallback, useRef } from "react";
import { CORE_URL } from "@/lib/constants";

export interface AppNotification {
  id: number;
  type: "info" | "warning" | "critical";
  title: string;
  body: string;
  read: boolean;
  sourceId: string | null;
  createdAt: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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

/**
 * Build the navigation target for a notification click.
 * View-only events go to a dashboard page; actionable events go to the
 * assistant with a prompt that explains the situation and asks before acting.
 */
export function getNotificationRoute(n: AppNotification): string {
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

export function useNotifications() {
  const { data, isLoading } = useSWR<AppNotification[]>(
    LIST_KEY,
    fetcher,
    { refreshInterval: 15000 }
  );

  const { data: countData } = useSWR<{ count: number }>(
    COUNT_KEY,
    fetcher,
    { refreshInterval: 15000 }
  );

  const { data: muteData } = useSWR<{ muted: boolean }>(
    MUTE_KEY,
    fetcher,
    { refreshInterval: 60000 }
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
    markRead,
    markAllRead,
    dismiss,
    toggleMute,
  };
}
