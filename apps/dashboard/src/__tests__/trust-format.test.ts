import { describe, it, expect } from "vitest";
import {
  actorDisplay,
  approvalHref,
  auditOutcome,
  auditQuery,
  auditTitle,
  countGrantedTools,
  effectiveApprovalStatus,
  expiryPresetDays,
  expiryPresetToIso,
  formatDuration,
  formatExpiry,
  formatTimeLeft,
  humanToolName,
  isExpired,
  livePending,
  parseApprovalRequest,
  summarizeScopes,
  validateScopes,
  type ApprovalItem,
  type GrantCatalog,
} from "@/components/trust/format";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("summarizeScopes", () => {
  it("describes the read-only default", () => {
    expect(summarizeScopes({ maxTier: "read", domains: "all", apps: "all" })).toBe("Read only · all tools · all apps");
  });

  it("names up to two domains and apps, counts beyond that", () => {
    expect(summarizeScopes({ maxTier: "modify", domains: ["arr", "core"], apps: ["sonarr"] })).toBe(
      "Read & modify · arr, core · sonarr",
    );
    expect(summarizeScopes({ maxTier: "destructive", domains: ["a", "b", "c"], apps: ["x", "y", "z", "w"] })).toBe(
      "Full control · 3 tool groups · 4 apps",
    );
  });

  it("mentions allow- and deny-lists", () => {
    expect(
      summarizeScopes({ maxTier: "read", domains: "all", apps: "all", tools: ["list_apps"], deniedTools: ["a", "b"] }),
    ).toBe("Read only · all tools · all apps · only 1 tool · 2 blocked");
  });

  it("flags legacy tokens regardless of stored scopes", () => {
    expect(summarizeScopes({ maxTier: "read", domains: "all", apps: "all" }, true)).toBe("Legacy full access");
  });

  it("says so when nothing is selected", () => {
    expect(summarizeScopes({ maxTier: "read", domains: [], apps: [] })).toBe("Read only · no tool groups · no apps");
  });
});

describe("validateScopes", () => {
  it("accepts all/all and non-empty lists", () => {
    expect(validateScopes({ maxTier: "read", domains: "all", apps: "all" })).toBeNull();
    expect(validateScopes({ maxTier: "read", domains: ["core"], apps: ["plex"] })).toBeNull();
  });

  it("rejects empty selections", () => {
    expect(validateScopes({ maxTier: "read", domains: [], apps: "all" })).toMatch(/tool group/);
    expect(validateScopes({ maxTier: "read", domains: "all", apps: [] })).toMatch(/app/);
  });
});

describe("countGrantedTools", () => {
  const catalog: GrantCatalog = {
    domains: [
      {
        name: "core",
        tools: [
          { name: "list_apps", tier: "read" },
          { name: "restart_app", tier: "modify" },
          { name: "uninstall_app", tier: "destructive" },
        ],
      },
      { name: "arr", tools: [{ name: "arr_status", tier: "read" }, { name: "arr_delete", tier: "destructive" }] },
    ],
    apps: [],
    defaults: { maxTier: "read", domains: "all", apps: "all" },
  };

  it("respects tier ceilings", () => {
    expect(countGrantedTools(catalog, { maxTier: "read", domains: "all", apps: "all" })).toBe(2);
    expect(countGrantedTools(catalog, { maxTier: "modify", domains: "all", apps: "all" })).toBe(3);
    expect(countGrantedTools(catalog, { maxTier: "destructive", domains: "all", apps: "all" })).toBe(5);
  });

  it("respects domains, allow-list and deny-list", () => {
    expect(countGrantedTools(catalog, { maxTier: "destructive", domains: ["arr"], apps: "all" })).toBe(2);
    expect(
      countGrantedTools(catalog, { maxTier: "destructive", domains: "all", apps: "all", tools: ["list_apps", "arr_delete"] }),
    ).toBe(2);
    expect(
      countGrantedTools(catalog, { maxTier: "destructive", domains: "all", apps: "all", deniedTools: ["uninstall_app"] }),
    ).toBe(4);
  });
});

describe("expiry", () => {
  it("maps presets to days and ISO timestamps", () => {
    expect(expiryPresetDays("7d")).toBe(7);
    expect(expiryPresetDays("90d")).toBe(90);
    expect(expiryPresetDays("never")).toBeNull();
    expect(expiryPresetToIso("30d", NOW)).toBe(at(30 * 86_400_000));
    expect(expiryPresetToIso("never", NOW)).toBeNull();
  });

  it("formats relative expiry", () => {
    expect(formatExpiry(null, NOW)).toBe("Never expires");
    expect(formatExpiry(at(-1), NOW)).toBe("Expired");
    expect(formatExpiry(at(10 * 60_000), NOW)).toBe("Expires in 10m");
    expect(formatExpiry(at(5 * 3_600_000), NOW)).toBe("Expires in 5h");
    expect(formatExpiry(at(12 * 86_400_000 + 1000), NOW)).toBe("Expires in 12d");
  });

  it("detects expired tokens", () => {
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired(at(1000), NOW)).toBe(false);
    expect(isExpired(at(0), NOW)).toBe(true);
  });
});

describe("formatTimeLeft (countdown)", () => {
  it("counts down in m:ss under an hour", () => {
    expect(formatTimeLeft(at(15 * 60_000), NOW)).toBe("15:00 left");
    expect(formatTimeLeft(at(65_500), NOW)).toBe("1:05 left");
    expect(formatTimeLeft(at(9_000), NOW)).toBe("0:09 left");
  });

  it("switches to hours for long windows", () => {
    expect(formatTimeLeft(at(2 * 3_600_000 + 5 * 60_000), NOW)).toBe("2h 5m left");
  });

  it("reports expiry and tolerates garbage", () => {
    expect(formatTimeLeft(at(0), NOW)).toBe("Expired");
    expect(formatTimeLeft(at(-60_000), NOW)).toBe("Expired");
    expect(formatTimeLeft("not a date", NOW)).toBe("Expired");
  });
});

describe("audit helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(42)).toBe("42 ms");
    expect(formatDuration(1_234)).toBe("1.2 s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("derives outcomes, falling back to the legacy approved flag", () => {
    expect(auditOutcome({ outcome: "success", approved: true })).toEqual({ label: "Succeeded", tone: "healthy" });
    expect(auditOutcome({ outcome: "blocked", approved: false }).tone).toBe("warning");
    expect(auditOutcome({ outcome: null, approved: true }).label).toBe("Recorded");
    expect(auditOutcome({ outcome: null, approved: false }).label).toBe("Blocked");
  });

  it("titles rows by tool, action, or approval decision", () => {
    expect(auditTitle({ action: "MCP: restart_app", toolName: "restart_app" })).toBe("Restart app");
    expect(auditTitle({ action: "Installed plex", toolName: null })).toBe("Installed plex");
    expect(auditTitle({ action: "Approval denied: uninstall_app", toolName: "uninstall_app" })).toBe(
      "Denied: Uninstall app",
    );
  });

  it("labels actors", () => {
    expect(actorDisplay("mcp_token", "Claude Desktop")).toBe("Claude Desktop");
    expect(actorDisplay("automation", null)).toBe("Automation");
    expect(actorDisplay(null, null)).toBe("Talome");
  });

  it("builds filter queries", () => {
    expect(auditQuery({ outcome: "all", source: "all", limit: 100 })).toBe("limit=100");
    expect(auditQuery({ outcome: "blocked", source: "mcp", limit: 200 })).toBe("limit=200&outcome=blocked&source=mcp");
  });

  it("humanizes tool names", () => {
    expect(humanToolName("bulk_update_apps")).toBe("Bulk update apps");
    expect(humanToolName("")).toBe("");
  });
});

describe("approvals", () => {
  const request = {
    status: "approval_required",
    approvalId: "apr_0123456789abcdef0123456789abcdef",
    approvalStatus: "pending",
    tool: "uninstall_app",
    summary: "Dashboard chat wants to run \"Uninstall app\" (destructive).",
    expiresAt: at(15 * 60_000),
    approveUrl: "/dashboard/settings/approvals?id=apr_0123456789abcdef0123456789abcdef",
    instructions: "…",
    error: "…",
  };

  it("parses approval_required results from objects and JSON strings", () => {
    const parsed = parseApprovalRequest(request);
    expect(parsed).toEqual({
      approvalId: request.approvalId,
      approvalStatus: "pending",
      tool: "uninstall_app",
      summary: request.summary,
      expiresAt: request.expiresAt,
    });
    expect(parseApprovalRequest(JSON.stringify(request))).toEqual(parsed);
  });

  it("ignores anything else", () => {
    expect(parseApprovalRequest(undefined)).toBeNull();
    expect(parseApprovalRequest({ success: true })).toBeNull();
    expect(parseApprovalRequest("plain text output")).toBeNull();
    expect(parseApprovalRequest("{approval_required")).toBeNull();
    expect(parseApprovalRequest({ ...request, approvalId: "../../etc" })).toBeNull();
    expect(parseApprovalRequest({ ...request, tool: "" })).toBeNull();
  });

  it("builds an encoded deep link", () => {
    expect(approvalHref("apr_abc")).toBe("/dashboard/settings/approvals?id=apr_abc");
    expect(approvalHref("a&b")).toBe("/dashboard/settings/approvals?id=a%26b");
  });

  const item = (over: Partial<ApprovalItem>): ApprovalItem => ({
    id: "apr_1",
    actor: { kind: "mcp_token", id: "t1", label: "Cursor" },
    source: "mcp",
    tool: "uninstall_app",
    summary: "",
    argsPreview: "",
    status: "pending",
    createdAt: at(-60_000),
    expiresAt: at(60_000),
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    ...over,
  });

  it("treats pending/approved rows past their TTL as expired", () => {
    expect(effectiveApprovalStatus(item({}), NOW)).toBe("pending");
    expect(effectiveApprovalStatus(item({ expiresAt: at(-1) }), NOW)).toBe("expired");
    expect(effectiveApprovalStatus(item({ status: "approved", expiresAt: at(-1) }), NOW)).toBe("expired");
    expect(effectiveApprovalStatus(item({ status: "consumed", expiresAt: at(-1) }), NOW)).toBe("consumed");
  });

  it("keeps only live pending approvals", () => {
    const list = [
      item({ id: "a" }),
      item({ id: "b", expiresAt: at(-1) }),
      item({ id: "c", status: "denied" }),
    ];
    expect(livePending(list, NOW).map((a) => a.id)).toEqual(["a"]);
    expect(livePending(undefined, NOW)).toEqual([]);
  });
});
