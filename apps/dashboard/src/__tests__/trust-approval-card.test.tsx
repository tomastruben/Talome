import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
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
import { APPROVAL_POLL_MS } from "@/components/trust/format";

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

function approvalRow(status: string, expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()) {
  return {
    id: APPROVAL_ID,
    actor: { kind: "user", id: "dashboard", label: "Dashboard chat" },
    source: "chat",
    tool: "uninstall_app",
    summary: "s",
    argsPreview: "{}",
    status,
    createdAt: new Date().toISOString(),
    expiresAt,
    decidedBy: status === "pending" ? null : "admin",
    decidedAt: status === "pending" ? null : new Date().toISOString(),
    consumedAt: null,
  };
}

function Harness({ out }: { out: unknown }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApprovalCard output={out} />
    </SWRConfig>
  );
}

function renderCard(out: unknown) {
  return render(<Harness out={out} />);
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
  vi.useRealTimers();
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

  describe("while pending", () => {
    let serverStatus = "pending";
    let expiresAt = "";
    const getCalls = () => fetchMock.mock.calls.filter(([, init]) => !init?.method).length;
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    /** Advance in 1 s steps so React renders between countdown ticks, as in a browser. */
    const advanceBySeconds = async (seconds: number) => {
      for (let i = 0; i < seconds; i++) await advance(1_000);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      serverStatus = "pending";
      expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      fetchMock.mockImplementation(async () => new Response(JSON.stringify(approvalRow(serverStatus, expiresAt)), { status: 200 }));
    });

    it("picks up a decision made elsewhere", async () => {
      renderCard({ ...output(), expiresAt });
      await advance(100);
      expect(screen.getByText("Approve Uninstall app?")).toBeInTheDocument();

      // Approved in Settings → Approvals (or on another device).
      serverStatus = "approved";
      await advanceBySeconds(APPROVAL_POLL_MS / 1_000 + 1);

      expect(screen.getByText("Uninstall app approved")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });

    it("keeps polling while the chat re-renders the card", async () => {
      const out = { ...output(), expiresAt };
      const { rerender } = renderCard(out);
      await advance(100);
      const before = getCalls();

      // Streaming chat updates re-render the card far more often than the
      // poll interval; the poll timer must survive them.
      for (let i = 0; i < 12; i++) {
        rerender(<Harness out={{ ...out }} />);
        await advance(1_000);
      }

      expect(getCalls() - before).toBeGreaterThanOrEqual(2);
    });

    it("pauses polling while the tab is hidden", async () => {
      renderCard({ ...output(), expiresAt });
      await advance(100);
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      try {
        const before = getCalls();
        await advance(APPROVAL_POLL_MS * 3);
        expect(getCalls()).toBe(before);
      } finally {
        visibility.mockRestore();
      }
    });

    it("counts down every second and stops polling once expired", async () => {
      renderCard({ ...output(), expiresAt });
      await advance(100);
      expect(screen.getByText("10:00 left")).toBeInTheDocument();
      await advance(1_000);
      expect(screen.getByText("9:59 left")).toBeInTheDocument();
      await advance(1_000);
      expect(screen.getByText("9:58 left")).toBeInTheDocument();

      await advance(10 * 60_000);
      expect(screen.getByText("Approval for Uninstall app expired")).toBeInTheDocument();
      expect(screen.queryByText(/left$/)).not.toBeInTheDocument();

      const after = getCalls();
      await advance(APPROVAL_POLL_MS * 3);
      expect(getCalls()).toBe(after);
    });
  });
});
