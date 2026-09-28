import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/components/icons", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the icon prop
  HugeiconsIcon: ({ icon: _icon, ...props }: Record<string, unknown>) => <svg data-testid="icon" {...props} />,
  SecurityCheckIcon: {},
  Clock01Icon: {},
  CheckmarkCircle01Icon: {},
  Cancel01Icon: {},
}));

const userState = { isAdmin: true, isLoading: false };
vi.mock("@/hooks/use-user", () => ({
  useUser: () => userState,
}));

const handleSubmit = vi.fn(async () => {});
vi.mock("@/components/assistant/assistant-context", () => ({
  useAssistant: () => ({ handleSubmit, status: "ready", isSubmitting: false }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ApprovalCard } from "@/components/trust/approval-card";

const APPROVAL_ID = "apr_0123456789abcdef0123456789abcdef";

function output() {
  return {
    status: "approval_required",
    approvalId: APPROVAL_ID,
    approvalStatus: "pending",
    tool: "uninstall_app",
    summary: "Dashboard chat wants to run \"Uninstall app\" (destructive).",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    approveUrl: `/dashboard/settings/approvals?id=${APPROVAL_ID}`,
    instructions: "Ask the user to approve it.",
    error: "Ask the user to approve it.",
  };
}

function approvalRow(status: string) {
  return {
    id: APPROVAL_ID,
    actor: { kind: "user", id: "dashboard", label: "Dashboard chat" },
    source: "chat",
    tool: "uninstall_app",
    summary: "s",
    argsPreview: "{}",
    status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    decidedBy: status === "pending" ? null : "admin",
    decidedAt: status === "pending" ? null : new Date().toISOString(),
    consumedAt: null,
  };
}

function renderCard(out: unknown) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApprovalCard output={out} />
    </SWRConfig>,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  userState.isAdmin = true;
  userState.isLoading = false;
  handleSubmit.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/approve")) {
      return new Response(JSON.stringify({ ok: true, approval: approvalRow("approved") }), { status: 200 });
    }
    if (init?.method === "POST" && url.endsWith("/deny")) {
      return new Response(JSON.stringify({ ok: true, approval: approvalRow("denied") }), { status: 200 });
    }
    return new Response(JSON.stringify(approvalRow("pending")), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApprovalCard", () => {
  it("renders nothing for ordinary tool output", () => {
    const { container } = renderCard({ success: true, apps: [] });
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approves via the REST API and asks the assistant to continue", async () => {
    renderCard(output());
    expect(screen.getByText("Approve Uninstall app?")).toBeInTheDocument();
    expect(screen.getByText(/left$/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/approvals/${APPROVAL_ID}/approve`,
        expect.objectContaining({ method: "POST", credentials: "include" }),
      ),
    );
    await waitFor(() => expect(handleSubmit).toHaveBeenCalledWith("Approved. Go ahead with Uninstall app."));
    expect(await screen.findByText("Uninstall app approved")).toBeInTheDocument();
  });

  it("denies without continuing the conversation", async () => {
    renderCard(output());
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("Uninstall app was denied")).toBeInTheDocument();
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it("shows members a waiting state without decision buttons or requests", () => {
    userState.isAdmin = false;
    renderCard(output());
    expect(screen.getByText(/Waiting for an admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an expired request as expired", () => {
    userState.isAdmin = false;
    renderCard({ ...output(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(screen.getByText("Approval for Uninstall app expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
