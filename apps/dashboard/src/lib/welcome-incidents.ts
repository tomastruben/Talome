import type { AppNotification } from "@/hooks/use-notifications";

const RECENT_MS = 24 * 60 * 60 * 1000;

/** Recent recorded incidents, not a claim about what is still unresolved. */
export function welcomeIncident(notifications: readonly AppNotification[], now: number) {
  const recent = notifications
    .filter((notification) => {
      const age = now - Date.parse(notification.createdAt);
      return notification.type !== "info" && age >= 0 && age < RECENT_MS;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const unique = new Map<string, AppNotification>();
  for (const notification of recent) {
    const key = `${notification.sourceId ?? ""}:${notification.title.trim().toLowerCase()}`;
    const previous = unique.get(key);
    if (!previous || (notification.type === "critical" && previous.type !== "critical")) {
      unique.set(key, notification);
    }
  }
  const incidents = [...unique.values()];
  const notification = incidents.find((incident) => incident.type === "critical") ?? incidents[0];
  if (!notification) return null;
  return {
    notification,
    headline: notification.type === "critical"
      ? "Something needs a closer look"
      : "A little bump in the road",
    more: incidents.length - 1,
  };
}
