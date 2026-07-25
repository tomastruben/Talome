import { describe, expect, it } from "vitest";
import { FEATURE_PERMISSIONS, PERMISSION_LABELS } from "@talome/types";
import {
  canAccessDashboardRoute,
  firstAccessibleDashboardRoute,
  getDashboardRouteRequirement,
} from "@/lib/dashboard-feature-access";

describe("dashboard feature access", () => {
  it("defines Intelligence as an editable feature permission", () => {
    expect(FEATURE_PERMISSIONS).toContain("intelligence");
    expect(PERMISSION_LABELS.intelligence.label).toBe("Intelligence");
  });

  it("blocks the dashboard page when dashboard access is disabled", () => {
    expect(canAccessDashboardRoute("/dashboard", "member", { dashboard: false })).toBe(false);
    expect(canAccessDashboardRoute("/dashboard/desktop", "member", { dashboard: false })).toBe(true);
  });

  it("blocks Intelligence and its legacy route when Intelligence is disabled", () => {
    expect(canAccessDashboardRoute("/dashboard/intelligence", "member", { intelligence: false })).toBe(false);
    expect(canAccessDashboardRoute("/dashboard/logs", "member", { intelligence: false })).toBe(false);
    expect(getDashboardRouteRequirement("/dashboard/intelligence")?.permission).toBe("intelligence");
  });

  it("lets administrators bypass feature restrictions", () => {
    expect(canAccessDashboardRoute("/dashboard/intelligence", "admin", { intelligence: false })).toBe(true);
    expect(canAccessDashboardRoute("/dashboard/terminal", "admin", {})).toBe(true);
  });

  it("redirects a restricted landing page to the first permitted app", () => {
    expect(firstAccessibleDashboardRoute("member", {
      dashboard: false,
      chat: false,
      media: true,
    })).toBe("/dashboard/media");
  });
});
