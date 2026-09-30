import { describe, expect, it } from "vitest";
import {
  getNotificationAction,
  getNotificationRoute,
  isApprovalNotification,
  type AppNotification,
} from "@/hooks/use-notifications";

const ADMIN = { isAdmin: true };
const MEMBER = { isAdmin: false };

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
    expect(getNotificationAction(notification({ link: "/dashboard/backups" }), ADMIN)).toEqual({
      href: "/dashboard/backups",
      label: "Open",
      external: false,
    });
    expect(getNotificationAction(notification({ link: "/dashboard/settings/approvals?id=abc" }), ADMIN)?.label).toBe("Review approval");
  });

  it("allows http(s) links as external and rejects unsafe ones", () => {
    expect(getNotificationAction(notification({ link: "https://example.com/docs" }), ADMIN)).toEqual({
      href: "https://example.com/docs",
      label: "Open link",
      external: true,
    });
    expect(getNotificationAction(notification({ link: "javascript:alert(1)" }), ADMIN)).toBeNull();
    expect(getNotificationAction(notification({ link: "//evil.example/x" }), ADMIN)).toBeNull();
    expect(getNotificationAction(notification({ link: "/\\evil.example" }), ADMIN)).toBeNull();
  });

  it("links older approval notifications from their approval:<id> reference", () => {
    expect(getNotificationAction(notification({ sourceId: "approval:3f2a-9b" }), ADMIN)).toEqual({
      href: "/dashboard/settings/approvals?id=3f2a-9b",
      label: "Review approval",
      external: false,
    });
    expect(
      getNotificationAction(notification({ body: "Run shell?\nSee approval:abc_123 for details" }), ADMIN)?.href,
    ).toBe("/dashboard/settings/approvals?id=abc_123");
    // The full body wins over the truncated display body.
    expect(
      getNotificationAction({ ...notification({ body: "Run shell…" }), fullBody: "Run shell\napproval:full-id" }, ADMIN)?.href,
    ).toBe("/dashboard/settings/approvals?id=full-id");
  });

  it("falls back to the approval reference when the link is unsafe", () => {
    expect(getNotificationAction(notification({ link: "javascript:void(0)", sourceId: "approval:x1" }), ADMIN)?.href).toBe(
      "/dashboard/settings/approvals?id=x1",
    );
  });

  it("returns null without a link or approval reference", () => {
    expect(getNotificationAction(notification(), ADMIN)).toBeNull();
    expect(getNotificationAction(notification({ link: null }), ADMIN)).toBeNull();
  });

  it("routes clicks to the action when there is one", () => {
    expect(getNotificationRoute(notification({ sourceId: "approval:x1", title: "Approval needed: Run shell" }), ADMIN)).toBe(
      "/dashboard/settings/approvals?id=x1",
    );
  });

  describe("for members (approvals are admin-only)", () => {
    const approvalLink = "/dashboard/settings/approvals?id=apr_x1";

    it("offers no approval action", () => {
      expect(getNotificationAction(notification({ link: approvalLink, sourceId: "approval:apr_x1" }), MEMBER)).toBeNull();
      expect(getNotificationAction(notification({ sourceId: "approval:apr_x1" }), MEMBER)).toBeNull();
      expect(getNotificationAction(notification({ body: "See approval:apr_x1" }), MEMBER)).toBeNull();
      expect(getNotificationAction(notification({ link: "javascript:void(0)", sourceId: "approval:x1" }), MEMBER)).toBeNull();
    });

    it("keeps non-approval actions", () => {
      expect(getNotificationAction(notification({ link: "/dashboard/backups" }), MEMBER)?.href).toBe("/dashboard/backups");
      expect(getNotificationAction(notification({ link: "https://example.com/docs" }), MEMBER)?.external).toBe(true);
    });

    it("routes approval clicks to the assistant instead of the approvals page", () => {
      const route = getNotificationRoute(
        notification({ link: approvalLink, sourceId: "approval:apr_x1", title: "Approval needed: Run shell" }),
        MEMBER,
      );
      expect(route).not.toContain("/dashboard/settings");
      expect(route.startsWith("/dashboard/assistant?prompt=")).toBe(true);
    });

    it("still recognises the notification as an approval request", () => {
      expect(isApprovalNotification(notification({ link: approvalLink }))).toBe(true);
      expect(isApprovalNotification(notification({ sourceId: "approval:apr_x1" }))).toBe(true);
      expect(isApprovalNotification(notification({ link: "/dashboard/backups" }))).toBe(false);
    });
  });
});
