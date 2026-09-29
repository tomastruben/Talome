import { describe, expect, it } from "vitest";
import {
  RETENTION_FIELDS,
  RETENTION_KEYS,
  describeRetentionDefault,
  retentionChanges,
  retentionDraftFromSettings,
  validateRetentionDraft,
  validateRetentionValue,
} from "@/lib/retention";

const field = (key: string) => {
  const found = RETENTION_FIELDS.find((f) => f.key === key);
  if (!found) throw new Error(`missing ${key}`);
  return found;
};

describe("retention fields", () => {
  it("covers every core retention setting key", () => {
    expect([...RETENTION_KEYS].sort()).toEqual(
      [
        "retention_audit_log_days",
        "retention_system_events_days",
        "retention_container_events_days",
        "retention_remediation_log_days",
        "retention_ai_usage_log_days",
        "retention_install_errors_days",
        "retention_notifications_read_days",
        "retention_notifications_unread_days",
        "retention_evolution_runs_keep",
      ].sort(),
    );
  });

  it("mirrors core defaults and minimums", () => {
    expect(field("retention_ai_usage_log_days")).toMatchObject({ defaultValue: 90, min: 31 });
    expect(field("retention_notifications_read_days")).toMatchObject({ defaultValue: 30, min: 1 });
    expect(field("retention_notifications_unread_days")).toMatchObject({ defaultValue: 0, min: 0 });
    expect(field("retention_evolution_runs_keep")).toMatchObject({ defaultValue: 200, min: 10, unit: "runs" });
    expect(describeRetentionDefault(field("retention_notifications_unread_days"))).toBe("Forever");
    expect(describeRetentionDefault(field("retention_audit_log_days"))).toBe("90 days");
  });
});

describe("validateRetentionValue", () => {
  it("accepts empty (default) and values within bounds", () => {
    expect(validateRetentionValue(field("retention_audit_log_days"), "")).toBeNull();
    expect(validateRetentionValue(field("retention_audit_log_days"), "365")).toBeNull();
    expect(validateRetentionValue(field("retention_notifications_unread_days"), "0")).toBeNull();
  });

  it("enforces minimums, maximums and whole numbers", () => {
    expect(validateRetentionValue(field("retention_ai_usage_log_days"), "30")).toBe("Minimum is 31 days");
    expect(validateRetentionValue(field("retention_audit_log_days"), "0")).toBe("Minimum is 1 days");
    expect(validateRetentionValue(field("retention_evolution_runs_keep"), "5")).toBe("Minimum is 10 runs");
    expect(validateRetentionValue(field("retention_audit_log_days"), "99999")).toMatch(/^Maximum is/);
    expect(validateRetentionValue(field("retention_audit_log_days"), "1.5")).toBe("Enter a whole number");
    expect(validateRetentionValue(field("retention_audit_log_days"), "-3")).toBe("Enter a whole number");
  });
});

describe("drafts and changes", () => {
  it("reads stored settings and ignores invalid stored values", () => {
    const draft = retentionDraftFromSettings({
      retention_audit_log_days: "120",
      retention_system_events_days: "abc",
      retention_evolution_runs_keep: " 050 ",
      unrelated_key: "x",
    });
    expect(draft.retention_audit_log_days).toBe("120");
    expect(draft.retention_system_events_days).toBe("");
    expect(draft.retention_evolution_runs_keep).toBe("50");
    expect(Object.keys(draft).sort()).toEqual([...RETENTION_KEYS].sort());
  });

  it("returns only changed keys, normalised, with '' to reset to the default", () => {
    const initial = retentionDraftFromSettings({ retention_audit_log_days: "120" });
    const draft = { ...initial, retention_audit_log_days: "", retention_install_errors_days: "007" };
    expect(retentionChanges(initial, draft)).toEqual({
      retention_audit_log_days: "",
      retention_install_errors_days: "7",
    });
    expect(retentionChanges(initial, initial)).toEqual({});
  });

  it("collects field errors for the whole draft", () => {
    const draft = retentionDraftFromSettings({});
    draft.retention_ai_usage_log_days = "10";
    expect(validateRetentionDraft(draft)).toEqual({ retention_ai_usage_log_days: "Minimum is 31 days" });
  });
});
