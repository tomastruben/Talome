import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));
vi.mock("@/components/settings/configure-with-ai", () => ({ ConfigureWithAI: () => null }));
vi.mock("@/components/settings/sections/chat-bot-senders", () => ({ ChatBotSenders: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { IntegrationsSection } from "@/components/settings/sections/integrations";

const fetchMock = vi.fn();
let settingsOk = true;
let saveOk = true;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

describe("chat bot notification levels", () => {
  beforeEach(() => {
    settingsOk = true;
    saveOk = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) return json({ connected: true, username: "talome_bot" });
      if (url === "http://core/api/settings" && init?.method === "POST") {
        return saveOk ? json({ ok: true }) : json({ error: "Couldn't write settings." }, 500);
      }
      if (url === "http://core/api/settings") {
        return settingsOk ? json({ telegram_notification_levels: "critical" }) : json({ error: "down" }, 500);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("keeps showing the saved levels when a change fails to save", async () => {
    saveOk = false;
    render(<IntegrationsSection />, { wrapper });
    const warning = (await screen.findAllByRole("button", { name: "warning" }))[0];
    await waitFor(() => expect(screen.getAllByRole("button", { name: "critical" })[0]).toHaveAttribute("aria-pressed", "true"));
    expect(warning).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(warning);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getAllByRole("button", { name: "warning" })[0]).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the new levels once the save succeeds", async () => {
    render(<IntegrationsSection />, { wrapper });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "critical" })[0]).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getAllByRole("button", { name: "warning" })[0]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "warning" })[0]).toHaveAttribute("aria-pressed", "true"));
  });

  it("says so when the saved settings couldn't be loaded, instead of showing defaults as saved", async () => {
    settingsOk = false;
    render(<IntegrationsSection />, { wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the saved bot settings");
    settingsOk = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
