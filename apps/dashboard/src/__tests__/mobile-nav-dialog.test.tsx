import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/hooks/use-downloads", () => ({
  adaptiveDownloadsInterval: () => 30_000,
  useDownloads: () => ({ totalCount: 0, isActivelyDownloading: false }),
}));
vi.mock("@/components/assistant/assistant-context", () => ({ useAssistant: () => ({ status: "ready" }) }));
vi.mock("@/components/trust/api", () => ({ usePendingApprovals: () => ({ count: 2, pending: [], mutate: vi.fn() }) }));
vi.mock("@/hooks/use-user", () => ({
  useUser: () => ({ user: { username: "tomas", role: "admin" }, isAdmin: true, hasPermission: () => true }),
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => <button type="button">Notifications</button>,
}));

import { MobileNav } from "@/components/layout/mobile-nav";

describe("mobile nav panel", () => {
  it("is a modal dialog that keeps Tab inside (regression: focus escaped to the page under the scrim)", async () => {
    const outside = document.createElement("button");
    outside.textContent = "Behind the scrim";
    document.body.appendChild(outside);
    try {
      render(<MobileNav open onClose={vi.fn()} />);
      const dialog = await screen.findByRole("dialog", { name: "Navigation" });
      const theme = screen.getByRole("button", { name: /Switch to light mode/ });
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
      expect(buttons.at(-1)).toBe(theme);

      theme.focus();
      fireEvent.keyDown(theme, { key: "Tab" });
      await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
      expect(dialog.contains(document.activeElement)).toBe(true);
      // The page behind is hidden from assistive tech while the panel is open.
      expect(outside.closest("[aria-hidden='true']")).not.toBeNull();
    } finally {
      outside.remove();
    }
  });

  it("reads the approvals count once", async () => {
    render(<MobileNav open onClose={vi.fn()} />);
    const approvals = await screen.findByRole("button", { name: /Approvals/ });
    expect(approvals).toHaveAccessibleName("Approvals, 2 waiting");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<MobileNav open onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
