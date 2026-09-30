import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopLink } from "@/components/desktop/desktop-link";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";

vi.mock("@/lib/desktop-navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/desktop-navigation")>(),
  requestDesktopNavigation: vi.fn(),
}));

const requestDesktopNavigationMock = vi.mocked(requestDesktopNavigation);

describe("DesktopLink", () => {
  beforeEach(() => {
    requestDesktopNavigationMock.mockReset();
  });

  it("routes a normal click through the desktop window manager", () => {
    requestDesktopNavigationMock.mockReturnValue(true);
    render(<DesktopLink href="/dashboard/media?tab=downloads">Downloads</DesktopLink>);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "Downloads" }).dispatchEvent(click);

    expect(requestDesktopNavigationMock).toHaveBeenCalledWith(
      "http://localhost:3000/dashboard/media?tab=downloads",
    );
    expect(click.defaultPrevented).toBe(true);
  });

  it("preserves modified clicks for browser tab behavior", () => {
    requestDesktopNavigationMock.mockReturnValue(true);
    render(<DesktopLink href="/dashboard/apps">App Store</DesktopLink>);

    fireEvent.click(screen.getByRole("link", { name: "App Store" }), {
      metaKey: true,
    });

    expect(requestDesktopNavigationMock).not.toHaveBeenCalled();
  });
  it.each([
    { target: "_blank" },
    { target: "_parent" },
    { download: "" },
    { "data-desktop-navigation": "bypass" },
  ])("preserves explicit browser semantics: %j", (props) => {
    render(<DesktopLink href="/dashboard/apps" {...props}>Browse</DesktopLink>);
    fireEvent.click(screen.getByRole("link", { name: "Browse" }));
    expect(requestDesktopNavigationMock).not.toHaveBeenCalled();
  });

  it("respects a caller that cancels navigation", () => {
    render(<DesktopLink href="/dashboard/apps" onClick={(event) => event.preventDefault()}>Browse</DesktopLink>);
    fireEvent.click(screen.getByRole("link", { name: "Browse" }));
    expect(requestDesktopNavigationMock).not.toHaveBeenCalled();
  });

});
