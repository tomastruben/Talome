import { describe, expect, it } from "vitest";
import { getSettingsAccessDecision } from "@/lib/settings-navigation";

describe("getSettingsAccessDecision", () => {
  it("waits for the user before redirecting an admin section", () => {
    expect(getSettingsAccessDecision({
      sectionExists: true,
      adminOnly: true,
      isAdmin: false,
      userPending: true,
    })).toBe("pending");
  });

  it("allows an admin after the user resolves", () => {
    expect(getSettingsAccessDecision({
      sectionExists: true,
      adminOnly: true,
      isAdmin: true,
      userPending: false,
    })).toBe("allow");
  });

  it("redirects a resolved non-admin from an admin section", () => {
    expect(getSettingsAccessDecision({
      sectionExists: true,
      adminOnly: true,
      isAdmin: false,
      userPending: false,
    })).toBe("redirect");
  });

  it("does not wait for the user on a public settings section", () => {
    expect(getSettingsAccessDecision({
      sectionExists: true,
      adminOnly: false,
      isAdmin: false,
      userPending: true,
    })).toBe("allow");
  });

  it("redirects an unknown section", () => {
    expect(getSettingsAccessDecision({
      sectionExists: false,
      adminOnly: false,
      isAdmin: true,
      userPending: false,
    })).toBe("redirect");
  });
});
