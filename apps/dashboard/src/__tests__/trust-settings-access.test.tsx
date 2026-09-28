import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { resolveSectionAccess } from "@/app/dashboard/settings/section-access";
import { APPROVAL_POLL_MS, approvalPollInterval, grantsTerminalAccess } from "@/components/trust/format";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ section: "approvals" }),
  useRouter: () => ({ replace }),
}));

const userState: { isAdmin: boolean; isLoading: boolean } = { isAdmin: false, isLoading: true };
vi.mock("@/hooks/use-user", () => ({ useUser: () => userState }));

vi.mock("@/components/settings/sections/general", () => ({ GeneralSection: () => <div data-testid="section">GeneralSection</div> }));
vi.mock("@/components/settings/sections/users", () => ({ UsersSection: () => <div data-testid="section">UsersSection</div> }));
vi.mock("@/components/settings/sections/ai-provider", () => ({ AiProviderSection: () => <div data-testid="section">AiProviderSection</div> }));
vi.mock("@/components/settings/sections/ai-tools", () => ({ AiToolsSection: () => <div data-testid="section">AiToolsSection</div> }));
vi.mock("@/components/settings/sections/ai-prompt", () => ({ AiPromptSection: () => <div data-testid="section">AiPromptSection</div> }));
vi.mock("@/components/settings/sections/ai-memory", () => ({ AiMemorySection: () => <div data-testid="section">AiMemorySection</div> }));
vi.mock("@/components/settings/sections/connections", () => ({ ConnectionsSection: () => <div data-testid="section">ConnectionsSection</div> }));
vi.mock("@/components/settings/sections/integrations", () => ({ IntegrationsSection: () => <div data-testid="section">IntegrationsSection</div> }));
vi.mock("@/components/settings/sections/mcp", () => ({ McpSection: () => <div data-testid="section">McpSection</div> }));
vi.mock("@/components/settings/sections/app-sources", () => ({ AppSourcesSection: () => <div data-testid="section">AppSourcesSection</div> }));
vi.mock("@/components/settings/sections/community-review", () => ({ CommunityReviewSection: () => <div data-testid="section">CommunityReviewSection</div> }));
vi.mock("@/components/settings/sections/setup-link", () => ({ ExportImportSection: () => <div data-testid="section">ExportImportSection</div> }));
vi.mock("@/components/settings/sections/networking", () => ({ NetworkingSection: () => <div data-testid="section">NetworkingSection</div> }));
vi.mock("@/components/settings/sections/backups", () => ({ BackupsSection: () => <div data-testid="section">BackupsSection</div> }));
vi.mock("@/components/settings/sections/intelligence", () => ({ IntelligenceSection: () => <div data-testid="section">IntelligenceSection</div> }));
vi.mock("@/components/settings/sections/ai-cost", () => ({ AiCostSection: () => <div data-testid="section">AiCostSection</div> }));
vi.mock("@/components/settings/sections/file-manager", () => ({ FileManagerSection: () => <div data-testid="section">FileManagerSection</div> }));
vi.mock("@/components/settings/sections/media-player", () => ({ MediaPlayerSection: () => <div data-testid="section">MediaPlayerSection</div> }));
vi.mock("@/components/settings/sections/legal", () => ({ LegalSection: () => <div data-testid="section">LegalSection</div> }));
vi.mock("@/components/settings/sections/notifications", () => ({ NotificationsSection: () => <div data-testid="section">NotificationsSection</div> }));
vi.mock("@/components/settings/sections/security", () => ({ SecuritySection: () => <div data-testid="section">SecuritySection</div> }));
vi.mock("@/components/settings/sections/updates", () => ({ UpdatesSection: () => <div data-testid="section">UpdatesSection</div> }));
vi.mock("@/components/settings/sections/approvals", () => ({ ApprovalsSection: () => <div data-testid="section">ApprovalsSection</div> }));
vi.mock("@/components/settings/sections/audit", () => ({ AuditSection: () => <div data-testid="section">AuditSection</div> }));

import SettingsSectionPage from "@/app/dashboard/settings/[section]/page";

describe("resolveSectionAccess", () => {
  it("waits for the user before deciding on admin-only sections", () => {
    expect(resolveSectionAccess({ exists: true, adminOnly: true, isAdmin: false, isLoading: true })).toBe("loading");
    expect(resolveSectionAccess({ exists: true, adminOnly: true, isAdmin: true, isLoading: false })).toBe("allowed");
    expect(resolveSectionAccess({ exists: true, adminOnly: true, isAdmin: false, isLoading: false })).toBe("redirect");
    expect(resolveSectionAccess({ exists: true, adminOnly: false, isAdmin: false, isLoading: true })).toBe("allowed");
    expect(resolveSectionAccess({ exists: false, isAdmin: true, isLoading: false })).toBe("redirect");
  });
});

describe("settings section page", () => {
  beforeEach(() => {
    replace.mockClear();
    userState.isAdmin = false;
    userState.isLoading = true;
  });

  it("keeps an approvals deep link on a cold load, then renders it for an admin", () => {
    const { rerender } = render(<SettingsSectionPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("section")).toBeNull();

    userState.isAdmin = true;
    userState.isLoading = false;
    rerender(<SettingsSectionPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("section")).toHaveTextContent("ApprovalsSection");
  });

  it("redirects a member once the user has loaded", () => {
    userState.isLoading = false;
    render(<SettingsSectionPage />);
    expect(replace).toHaveBeenCalledWith("/dashboard/settings");
  });
});

describe("approvalPollInterval", () => {
  const future = (ms: number) => new Date(Date.now() + ms).toISOString();
  it("polls only while pending/approved and unexpired", () => {
    expect(approvalPollInterval({ status: "pending", expiresAt: future(60_000) })).toBe(APPROVAL_POLL_MS);
    expect(approvalPollInterval({ status: "approved", expiresAt: future(60_000) })).toBe(APPROVAL_POLL_MS);
    expect(approvalPollInterval({ status: "pending", expiresAt: future(-1_000) })).toBe(0);
    expect(approvalPollInterval({ status: "approved", expiresAt: future(-1_000) })).toBe(0);
    expect(approvalPollInterval({ status: "consumed", expiresAt: future(60_000) })).toBe(0);
    expect(approvalPollInterval({ status: "denied", expiresAt: future(60_000) })).toBe(0);
  });
});

describe("grantsTerminalAccess", () => {
  it("is true only for unrestricted destructive grants", () => {
    const full = { maxTier: "destructive" as const, domains: "all" as const, apps: "all" as const };
    expect(grantsTerminalAccess(full)).toBe(true);
    expect(grantsTerminalAccess({ ...full, apps: ["sonarr"] })).toBe(false);
    expect(grantsTerminalAccess({ ...full, domains: ["arr"] })).toBe(false);
    expect(grantsTerminalAccess({ ...full, maxTier: "modify" })).toBe(false);
    expect(grantsTerminalAccess({ ...full, deniedTools: ["run_shell"] })).toBe(false);
    expect(grantsTerminalAccess({ ...full, tools: ["list_apps"] })).toBe(false);
  });
});
