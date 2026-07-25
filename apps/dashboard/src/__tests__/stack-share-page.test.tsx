import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/icons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/icons")>()),
  HugeiconsIcon: () => <svg />,
}));

vi.mock("@/hooks/use-installed-apps", () => ({
  useInstalledApps: () => ({
    apps: [{ id: "jellyfin", name: "Jellyfin", icon: "🎬" }],
    isLoading: false,
  }),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    span: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import SharePage from "@/app/dashboard/share/page";

const fetchMock = vi.fn();

describe("portable stack sharing", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NEXT_PUBLIC_TALOME_SHARE_URL", "");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Not allowed in iframe")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
  });

  it("creates a focused share package without offering QR sharing", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stack: { id: "home", name: "Home", apps: [{ appId: "jellyfin" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          capsuleCode: "t2.portable-recipe.abcdefghijkl",
          fingerprint: "abcdefghijkl",
          qrEligible: true,
          maxQrPayloadLength: 2200,
          publicLinkEligible: true,
          recipeFileCode: "t2.portable-recipe.abcdefghijkl",
          recipeFileName: "home.talome-stack",
          recoveryFileCode: "t1.recovery",
          recoveryFileName: "home.talome-recovery",
          hasCustomApps: false,
          recommendedTransport: "qr-or-code",
          fileCode: "t1.recovery",
          fileName: "home.talome-stack",
          linkCompatible: true,
          capsuleLength: 35,
          maxLinkLength: 7500,
          missingCatalogApps: [],
        }),
      });

    render(<SharePage />);

    expect(screen.getByText("Portable recipe, not a backup")).toBeInTheDocument();
    expect(screen.getByText(/does not copy databases, media, settings/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Export & Import/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare share package" }));

    expect(await screen.findByText("t2.portable-recipe.abcdefghijkl")).toBeInTheDocument();
    expect(screen.getByText("Recipe ready to share")).toBeInTheDocument();
    expect(screen.getByText(/1 app packaged safely/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share recipe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByText(/qr/i)).not.toBeInTheDocument();
    expect(screen.getByText(/public preview links are not enabled/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
