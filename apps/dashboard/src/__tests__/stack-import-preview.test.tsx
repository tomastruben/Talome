import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/icons", () => ({
  HugeiconsIcon: () => <svg data-testid="icon" />,
  AiChat02Icon: {},
  AlertCircleIcon: {},
  CheckmarkCircle01Icon: {},
  Download01Icon: {},
  FileAttachmentIcon: {},
  Layers01Icon: {},
  Package01Icon: {},
}));

vi.mock("@/components/settings/configure-with-ai", () => ({
  ConfigureWithAI: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ExportImportSection } from "@/components/settings/sections/setup-link";

const fetchMock = vi.fn();

describe("stack import preview", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.NEXT_PUBLIC_TALOME_SHARE_URL = "https://talome.dev/share/";
    sessionStorage.clear();
  });

  it("shows catalog readiness and continues to Assistant with an actionable prompt", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ applied: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          valid: true,
          stack: {
            id: "shared-media",
            name: "Shared Media",
            description: "A portable media setup",
            apps: [
              {
                appId: "jellyfin",
                name: "Jellyfin",
                storeId: "talome-store",
                available: true,
                installed: false,
                requiredInputCount: 1,
              },
              {
                appId: "custom-indexer",
                name: "Custom Indexer",
                available: false,
                installed: false,
                requiredInputCount: 0,
              },
            ],
          },
          requiredInputs: [{
            appId: "jellyfin",
            appName: "Jellyfin",
            key: "MEDIA_PATH",
            description: "Media library path",
            secret: false,
          }],
          summary: {
            installedCount: 0,
            availableCount: 1,
            missingCount: 1,
            requiredInputCount: 1,
          },
          message: "1 required field will be requested during setup.",
        }),
      });

    render(<ExportImportSection />);
    fireEvent.change(screen.getByPlaceholderText("Paste code..."), {
      target: { value: "portable-stack-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Shared Media")).toBeInTheDocument();
    expect(screen.getByText("1 input")).toBeInTheDocument();
    expect(screen.getByText("Not in catalog")).toBeInTheDocument();

    const assistantLink = screen.getByRole("link", { name: /continue with assistant/i });
    expect(assistantLink).toHaveAttribute("href", expect.stringContaining("/dashboard/assistant?prompt="));
    expect(decodeURIComponent(assistantLink.getAttribute("href") ?? "")).toContain("talome-store/jellyfin");
    expect(decodeURIComponent(assistantLink.getAttribute("href") ?? "")).toContain("Custom Indexer");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("exports a portable code with optional public preview and separate recovery", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ stack: { id: "home", name: "Home", apps: [{ appId: "jellyfin" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          capsuleCode: "t2.compact-catalog-recipe.abcdefghijkl",
          fingerprint: "abcdefghijkl",
          qrEligible: true,
          maxQrPayloadLength: 2200,
          publicLinkEligible: true,
          recipeFileCode: "t2.compact-catalog-recipe.abcdefghijkl",
          recipeFileName: "home.talome-stack",
          recoveryFileCode: "t1.very-large-portable-code",
          recoveryFileName: "home.talome-recovery",
          hasCustomApps: false,
          recommendedTransport: "qr-or-code",
          fileCode: "t1.very-large-portable-code",
          fileName: "home.talome-stack",
          linkCompatible: true,
          capsuleLength: 25,
          maxLinkLength: 7500,
          missingCatalogApps: [],
        }),
      });

    render(<ExportImportSection />);
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    fireEvent.click(generateButtons[1]);

    expect(await screen.findByText("t2.compact-catalog-recipe.abcdefghijkl")).toBeInTheDocument();
    expect(screen.queryByText("t1.very-large-portable-code")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preview" })).toHaveAttribute(
      "href",
      "https://talome.dev/share/#t2.compact-catalog-recipe.abcdefghijkl",
    );
    expect(screen.getByRole("button", { name: "Recipe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recovery" })).not.toBeInTheDocument();
  });

  it("automatically previews a capsule handed off through the same browser", async () => {
    sessionStorage.setItem("talome:pending-stack-import:v1", "t2.private-lan-capsule.abcdefghijkl");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        valid: true,
        stack: {
          id: "private-stack",
          name: "Private LAN stack",
          description: "Received without contacting its sender",
          apps: [{
            appId: "jellyfin",
            name: "Jellyfin",
            available: true,
            installed: false,
            requiredInputCount: 0,
          }],
        },
        requiredInputs: [],
        summary: { installedCount: 0, availableCount: 1, missingCount: 0, requiredInputCount: 0 },
        message: "Ready to recreate.",
      }),
    });

    render(<ExportImportSection />);

    expect(await screen.findByText("Private LAN stack")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/stacks/import-code"),
      expect.objectContaining({ body: JSON.stringify({ code: "t2.private-lan-capsule.abcdefghijkl" }) }),
    );
    expect(sessionStorage.getItem("talome:pending-stack-import:v1")).toBeNull();
  });
});
