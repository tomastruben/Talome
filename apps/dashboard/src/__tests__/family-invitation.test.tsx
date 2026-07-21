import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "secure-invitation-token-1234567890" }),
  useRouter: () => ({ replace: replaceMock, refresh: refreshMock }),
}));

import AcceptInvitationPage from "@/app/invite/[token]/page";

const fetchMock = vi.fn();

describe("family invitation recipient journey", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    replaceMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("lets the recipient choose credentials and shows the one-time recovery code", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          email: "family@example.com",
          role: "member",
          expiresAt: "2099-07-27T12:00:00.000Z",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ recoveryCode: "one-time-recovery-code" }),
      });

    render(<AcceptInvitationPage />);

    expect(await screen.findByText(/family@example\.com was invited as a family member/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Choose a username"), { target: { value: "alex" } });
    fireEvent.change(screen.getByPlaceholderText("Choose a password (min 8 characters)"), { target: { value: "long-password" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm password"), { target: { value: "long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my account" }));

    expect(await screen.findByText("one-time-recovery-code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Talome" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toContain("/api/auth/invitations/secure-invitation-token-1234567890/accept");
  });
});
