import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error, warning: mocks.warning } }));
vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));

import { VoiceSettings } from "@/components/settings/voice-settings";

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const STORED = {
  voice_stt_url: "http://whisper:8000/v1",
  voice_stt_model: "whisper-1",
  voice_stt_key: "(configured)",
  voice_live_enabled: "true",
};

/** Answers the two loads; `post` answers the save. */
function serve(post: () => unknown, settings: () => unknown = () => json(STORED)) {
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "http://core/api/settings" && init?.method === "POST") return post();
    if (url === "http://core/api/settings") return settings();
    if (url === "http://core/api/voice/status") return json({ liveVoices: ["marin"] });
    throw new Error(`unexpected ${url}`);
  });
}

async function saveNewServer() {
  const input = await screen.findByDisplayValue("http://whisper:8000/v1");
  fireEvent.change(input, { target: { value: "http://elsewhere.example:8000/v1" } });
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
}

describe("voice settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("saves through the shared settings helper and confirms only a real save", async () => {
    serve(() => json({ ok: true }));
    render(<VoiceSettings />);
    await saveNewServer();

    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Voice settings saved"));
    const post = mocks.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(post?.[1]).toMatchObject({ credentials: "include" });
    const body = JSON.parse(String((post?.[1] as RequestInit).body));
    expect(body.voice_stt_url).toBe("http://elsewhere.example:8000/v1");
    // The stored key is not re-sent (it isn't being edited).
    expect(body).not.toHaveProperty("voice_stt_key");
  });

  it("says a held change is waiting for approval, with a link, instead of failing", async () => {
    serve(() => json({
      status: "approval_required",
      approvalId: "apr_0123456789ab",
      approvalStatus: "pending",
      tool: "set_setting",
      summary: "Change voice_stt_url",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }, 202));
    render(<VoiceSettings />);
    await saveNewServer();

    await waitFor(() => expect(mocks.warning).toHaveBeenCalledTimes(1));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.warning.mock.calls[0][0]).toBe("Waiting for approval");
    // The notice stays next to Save, with a link to the approval.
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for approval");
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/dashboard/settings/approvals?id=apr_0123456789ab");
  });

  it("treats an approval in an error response the same way", async () => {
    serve(() => json({
      error: "Needs approval",
      approval: { status: "approval_required", approvalId: "apr_abcdefabcdef", tool: "set_setting", summary: "", expiresAt: "" },
    }, 403));
    render(<VoiceSettings />);
    await saveNewServer();
    await waitFor(() => expect(mocks.warning).toHaveBeenCalledTimes(1));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("shows the server's reason when a save fails", async () => {
    serve(() => json({ error: "Too many keys (max 50)" }, 400));
    render(<VoiceSettings />);
    await saveNewServer();
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Too many keys (max 50)"));
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("never offers Save over settings that failed to load, and retries", async () => {
    let fail = true;
    serve(() => json({ ok: true }), () => (fail ? json({ error: "db" }, 500) : json(STORED)));
    render(<VoiceSettings />);

    expect(await screen.findByText("Couldn't load the voice settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("http://whisper:8000/v1")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the voice settings.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
