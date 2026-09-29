import { describe, expect, it } from "vitest";
import { getNotificationAction, getNotificationRoute, type AppNotification } from "@/hooks/use-notifications";

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 1,
    type: "warning",
    title: "Something happened",
    body: "",
    read: false,
    sourceId: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("getNotificationAction", () => {
  it("uses the server-provided internal link", () => {
    expect(getNotificationAction(notification({ link: "/dashboard/backups" }))).toEqual({
      href: "/dashboard/backups",
      label: "Open",
      external: false,
    });
    expect(getNotificationAction(notification({ link: "/dashboard/settings/approvals?id=abc" }))?.label).toBe("Review approval");
  });

  it("allows http(s) links as external and rejects unsafe ones", () => {
    expect(getNotificationAction(notification({ link: "https://example.com/docs" }))).toEqual({
      href: "https://example.com/docs",
      label: "Open link",
      external: true,
    });
    expect(getNotificationAction(notification({ link: "javascript:alert(1)" }))).toBeNull();
    expect(getNotificationAction(notification({ link: "//evil.example/x" }))).toBeNull();
    expect(getNotificationAction(notification({ link: "/\\evil.example" }))).toBeNull();
  });

  it("links older approval notifications from their approval:<id> reference", () => {
    expect(getNotificationAction(notification({ sourceId: "approval:3f2a-9b" }))).toEqual({
      href: "/dashboard/settings/approvals?id=3f2a-9b",
      label: "Review approval",
      external: false,
    });
    expect(
      getNotificationAction(notification({ body: "Run shell?\nSee approval:abc_123 for details" }))?.href,
    ).toBe("/dashboard/settings/approvals?id=abc_123");
    // The full body wins over the truncated display body.
    expect(
      getNotificationAction({ ...notification({ body: "Run shell…" }), fullBody: "Run shell\napproval:full-id" })?.href,
    ).toBe("/dashboard/settings/approvals?id=full-id");
  });

  it("falls back to the approval reference when the link is unsafe", () => {
    expect(getNotificationAction(notification({ link: "javascript:void(0)", sourceId: "approval:x1" }))?.href).toBe(
      "/dashboard/settings/approvals?id=x1",
    );
  });

  it("returns null without a link or approval reference", () => {
    expect(getNotificationAction(notification())).toBeNull();
    expect(getNotificationAction(notification({ link: null }))).toBeNull();
  });

  it("routes clicks to the action when there is one", () => {
    expect(getNotificationRoute(notification({ sourceId: "approval:x1", title: "Approval needed: Run shell" }))).toBe(
      "/dashboard/settings/approvals?id=x1",
    );
  });
});
