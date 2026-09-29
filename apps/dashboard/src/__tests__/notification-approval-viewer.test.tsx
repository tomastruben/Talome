import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AppNotification } from "@/hooks/use-notifications";

const userState = { isAdmin: false, isLoading: false };
vi.mock("@/hooks/use-user", () => ({ useUser: () => userState }));

const { push, toastWarning } = vi.hoisted(() => ({ push: vi.fn(), toastWarning: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() } }));

type ListItem = AppNotification & { fullBody: string };
const notificationsState: { notifications: ListItem[]; isMuted: boolean } = { notifications: [], isMuted: false };
vi.mock("@/hooks/use-notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-notifications")>()),
  useNotifications: () => notificationsState,
}));

vi.mock("@/components/assistant/assistant-context", () => ({
  useAssistant: () => ({ handleSubmit: vi.fn() }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/icons", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip the icon prop
  HugeiconsIcon: ({ icon: _icon, ...props }: Record<string, unknown>) => <svg data-testid="icon" {...props} />,
  BubbleChatDownload02Icon: {},
}));

import { NotificationToastBridge } from "@/components/notifications/notification-toast-bridge";
import { NotificationDetailSheet } from "@/components/notifications/notification-detail-sheet";

const APPROVAL_LINK = "/dashboard/settings/approvals?id=apr_0123456789abcdef";

function approvalNotification(id: number): ListItem {
  const body = `Dashboard chat wants to run "Run shell".\nReview it in Settings -> Approvals: ${APPROVAL_LINK}`;
  return {
    id,
    type: "warning",
    title: "Approval needed: Run shell",
    body,
    fullBody: body,
    read: false,
    sourceId: "approval:apr_0123456789abcdef",
    createdAt: "2026-09-29T10:00:00.000Z",
    link: APPROVAL_LINK,
  };
}

/** Mounts the bridge with an existing list, then delivers a new approval notification. */
function deliverApprovalToast() {
  notificationsState.notifications = [];
  const { rerender } = render(<NotificationToastBridge />);
  notificationsState.notifications = [{ ...approvalNotification(1), read: true }];
  rerender(<NotificationToastBridge />);
  notificationsState.notifications = [approvalNotification(2), { ...approvalNotification(1), read: true }];
  rerender(<NotificationToastBridge />);
}

beforeEach(() => {
  userState.isAdmin = false;
  userState.isLoading = false;
  toastWarning.mockClear();
  push.mockClear();
});

describe("approval notification toast", () => {
  it("offers admins a Review approval action", () => {
    userState.isAdmin = true;
    deliverApprovalToast();
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const options = toastWarning.mock.calls[0][1] as { action?: { label: string; onClick: () => void } };
    expect(options.action?.label).toBe("Review approval");
    options.action?.onClick();
    expect(push).toHaveBeenCalledWith(APPROVAL_LINK);
  });

  it("shows members the toast without an action that would bounce them", () => {
    deliverApprovalToast();
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const options = toastWarning.mock.calls[0][1] as { action?: unknown };
    expect(options.action).toBeUndefined();
  });
});

describe("approval notification detail sheet", () => {
  const renderSheet = () =>
    render(<NotificationDetailSheet open onOpenChange={() => {}} notification={approvalNotification(3)} />);

  it("links admins to the approval", () => {
    userState.isAdmin = true;
    renderSheet();
    expect(screen.getByRole("link", { name: "Review approval" })).toHaveAttribute("href", APPROVAL_LINK);
    expect(screen.queryByText(/Waiting for an admin/)).not.toBeInTheDocument();
  });

  it("shows members a waiting state instead of the approvals link", () => {
    renderSheet();
    expect(screen.queryByRole("link", { name: "Review approval" })).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for an admin to review it.")).toBeInTheDocument();
  });
});
