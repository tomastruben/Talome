import { describe, expect, it } from "vitest";
import { checkTone, parseVerificationResponse, sortChecks, verificationTone } from "@/lib/verification";

describe("parseVerificationResponse", () => {
  it("parses a persisted result with checks and chain", () => {
    const result = parseVerificationResponse({
      result: {
        targetType: "stack",
        targetId: "media-server",
        status: "degraded",
        summary: "1 of 3 checks need attention",
        checks: [
          { id: "a", label: "Jellyfin answers", status: "pass", evidence: "HTTP 200", critical: true, active: false, durationMs: 12 },
          { id: "b", label: "Library folders exist", status: "warn", evidence: "/mnt/tv missing", remediation: "Create it", critical: false, active: false },
          { id: 3, label: "broken" },
        ],
        chain: [{ id: "library", label: "Appear in the library", status: "warn", checkIds: ["library:"] }],
        includeActive: false,
        durationMs: 40,
        verifiedAt: "2026-09-29T10:00:00.000Z",
      },
    });
    expect(result).toMatchObject({ status: "degraded", targetType: "stack", summary: "1 of 3 checks need attention" });
    expect(result?.checks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result?.checks[1].remediation).toBe("Create it");
    expect(result?.chain).toEqual([{ id: "library", label: "Appear in the library", status: "warn" }]);
  });

  it("returns null when there is no result yet or the payload is malformed", () => {
    expect(parseVerificationResponse({ result: null })).toBeNull();
    expect(parseVerificationResponse({ result: { status: "great" } })).toBeNull();
    expect(parseVerificationResponse(undefined)).toBeNull();
  });
});

describe("verification helpers", () => {
  it("orders failing critical checks first", () => {
    const base = { evidence: "", active: false };
    const sorted = sortChecks([
      { ...base, id: "pass", label: "p", status: "pass", critical: true },
      { ...base, id: "warn", label: "w", status: "warn", critical: false },
      { ...base, id: "fail-minor", label: "f", status: "fail", critical: false },
      { ...base, id: "fail-critical", label: "F", status: "fail", critical: true },
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["fail-critical", "fail-minor", "warn", "pass"]);
  });

  it("maps statuses to tones", () => {
    expect(verificationTone("verified")).toBe("healthy");
    expect(verificationTone("degraded")).toBe("warning");
    expect(verificationTone("failed")).toBe("critical");
    expect(verificationTone("unknown")).toBe("muted");
    expect(checkTone("timeout")).toBe("warning");
    expect(checkTone("skip")).toBe("muted");
  });
});
