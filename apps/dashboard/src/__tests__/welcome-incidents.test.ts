import { describe, expect, it } from "vitest";
import type { AppNotification } from "@/hooks/use-notifications";
import { welcomeIncident } from "@/lib/welcome-incidents";

const now = Date.parse("2026-10-03T12:00:00Z");
function alert(id: number, patch: Partial<AppNotification> = {}): AppNotification {
  return { id, type: "warning", title: "Radarr check degraded", body: "", read: false, sourceId: "radarr", createdAt: "2026-10-03T11:00:00Z", ...patch };
}

describe("welcome incidents", () => {
  it("omits stale, informational, invalid and future notifications without inventing an all-clear", () => {
    expect(welcomeIncident([
      alert(1, { createdAt: "2026-10-02T12:00:00Z" }),
      alert(2, { type: "info" }),
      alert(3, { createdAt: "invalid" }),
      alert(4, { createdAt: "2026-10-03T13:00:00Z" }),
    ], now)).toBeNull();
  });
  it("prioritizes critical incidents without playful wording", () => {
    const result = welcomeIncident([alert(1), alert(2, { title: "Backup failed", type: "critical", createdAt: "2026-10-03T10:00:00Z" })], now);
    expect(result?.notification.id).toBe(2);
    expect(result?.headline).toBe("Something needs a closer look");
    expect(result?.more).toBe(1);
  });
  it("groups repeats and keeps the newest warning, including read events because read does not mean resolved", () => {
    const result = welcomeIncident([alert(1, { createdAt: "2026-10-03T10:00:00Z" }), alert(2, { read: true }), alert(3, { sourceId: "other" })], now);
    expect(result?.notification.id).toBe(2);
    expect(result?.more).toBe(1);
    expect(result?.headline).toBe("A little bump in the road");
  });
  it("does not hide a repeated critical incident behind a newer warning", () => {
    expect(welcomeIncident([alert(1), alert(2, { type: "critical", createdAt: "2026-10-03T10:00:00Z" })], now)?.notification.id).toBe(2);
  });
});
