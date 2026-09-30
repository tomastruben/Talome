import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inFlightConsequence,
  processDotState,
  restartSettled,
  runVerifiedRestart,
  type RestartDeps,
  type SupervisorState,
} from "@/lib/service-restart";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  assistantStatus: "ready" as string,
  success: vi.fn(),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/components/assistant/assistant-context", () => ({ useAssistant: () => ({ status: mocks.assistantStatus }) }));
vi.mock("@/hooks/use-user", () => ({ useUser: () => ({ isAdmin: true }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: vi.fn() } }));

import { ServicesSection } from "@/components/system/services-section";

const state = (pids: Partial<Record<string, number | null>>, status = "healthy"): SupervisorState => ({
  processes: Object.fromEntries(Object.entries(pids).map(([key, pid]) => [key, { pid: pid ?? null, status }])),
});

function deps(overrides: Partial<RestartDeps> & { statuses?: Array<SupervisorState | null> } = {}): RestartDeps {
  let clock = 0;
  const statuses = overrides.statuses ?? [];
  let call = 0;
  return {
    request: overrides.request ?? (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    readStatus: overrides.readStatus ?? (async () => statuses[Math.min(call++, statuses.length - 1)] ?? null),
    sleep: overrides.sleep ?? (async (ms) => { clock += ms; }),
    now: overrides.now ?? (() => clock),
  };
}

describe("verified restart", () => {
  it("reports a failed request instead of pretending (regression: res.ok was never checked)", async () => {
    const outcome = await runVerifiedRestart("core", state({ core: 10 }), deps({
      request: async () => new Response(JSON.stringify({ error: "Supervisor not running" }), { status: 500 }),
    }));
    expect(outcome).toEqual({ ok: false, reason: "request", error: "Couldn't restart: Supervisor not running." });
  });

  it("is done only when the process is healthy under a new pid", async () => {
    const before = state({ core: 10 });
    const outcome = await runVerifiedRestart("core", before, deps({
      statuses: [null, state({ core: 10 }), state({ core: 22 }, "starting"), state({ core: 22 })],
    }));
    expect(outcome).toEqual({ ok: true });
    expect(restartSettled(before, state({ core: 10 }), ["core"])).toBe(false);
    expect(restartSettled(before, state({ core: 22 }, "starting"), ["core"])).toBe(false);
  });

  it("says it couldn't confirm when the service never comes back", async () => {
    const outcome = await runVerifiedRestart("terminal_daemon", state({ terminal_daemon: 3 }), deps({
      statuses: [state({ terminal_daemon: 3 })],
    }), { pollMs: 1000, timeoutMs: 5000 });
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
  });

  it("restart all waits for every process", () => {
    const before = state({ core: 1, dashboard: 2, terminal_daemon: 3 });
    expect(restartSettled(before, state({ core: 11, dashboard: 12, terminal_daemon: 3 }), ["core", "dashboard", "terminal_daemon"])).toBe(false);
    expect(restartSettled(before, state({ core: 11, dashboard: 12, terminal_daemon: 13 }), ["core", "dashboard", "terminal_daemon"])).toBe(true);
  });

  it("describes what a restart interrupts, and admits when it couldn't check", () => {
    expect(inFlightConsequence({ operations: [], evolutionRuns: 0, assistantReplying: false, unknown: false }, "core")).toBeNull();
    expect(inFlightConsequence({ operations: ["Updating jellyfin", "Backing up immich", "Installing sonarr"], evolutionRuns: 1, assistantReplying: true, unknown: false }, "core"))
      .toBe("Restarting Core interrupts Updating jellyfin, Backing up immich and 1 more, a self-improvement run and the Assistant's reply.");
    expect(inFlightConsequence({ operations: [], evolutionRuns: 0, assistantReplying: false, unknown: true }, "all"))
      .toBe("Restarting every service may interrupt running work: Talome couldn't check what is running.");
  });

  it("maps supervisor states to the status grammar (crashed is failed, stopped is grey)", () => {
    expect(processDotState({ pid: 1, status: "healthy" }).state).toBe("healthy");
    expect(processDotState({ pid: 1, status: "starting" }).state).toBe("working");
    expect(processDotState({ pid: null, status: "crashed" })).toEqual({ state: "failed", label: "Crashed" });
    expect(processDotState({ pid: null, status: "stopped" }).state).toBe("stopped");
    expect(processDotState(undefined).state).toBe("unknown");
  });
});

describe("Settings → Services restart", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.success.mockReset();
    mocks.assistantStatus = "ready";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function route(handlers: { operations?: unknown; evolution?: unknown }) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/supervisor/status")) return new Response(JSON.stringify(state({ core: 10, dashboard: 20, terminal_daemon: 30 })), { status: 200 });
      if (url.includes("/api/operations")) return new Response(JSON.stringify(handlers.operations ?? []), { status: 200 });
      if (url.includes("/api/evolution/suggestions")) return new Response(JSON.stringify(handlers.evolution ?? { suggestions: [] }), { status: 200 });
      if (url.includes("/api/supervisor/restart") && init?.method === "POST") return new Response("{}", { status: 200 });
      return new Response("{}", { status: 404 });
    });
  }

  function renderSection() {
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ServicesSection heading={<h2>Services</h2>} />
      </SWRConfig>,
    );
  }

  it("asks before restarting while an app operation is in flight, and does nothing when cancelled", async () => {
    route({
      operations: [{
        id: "op1", appId: "jellyfin", kind: "update", actor: "user", status: "running", step: null, progress: 0.4,
        detail: null, error: null, startedAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T10:00:05Z", finishedAt: null,
      }],
    });
    mocks.confirm.mockResolvedValue({ confirmed: false, optionChecked: false });
    renderSection();
    const [coreRestart] = await screen.findAllByRole("button", { name: "Restart" });
    fireEvent.click(coreRestart);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.confirm.mock.calls[0][0]).toMatchObject({
      tier: "soft",
      title: "Restart Core now?",
      consequence: expect.stringContaining("Updating jellyfin"),
      confirmLabel: "Restart Core",
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/restart") && init?.method === "POST")).toBe(false);
  });

  it("shows the server's error instead of a fixed-timer success", async () => {
    route({});
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/supervisor/restart") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Supervisor not running" }), { status: 500 });
      }
      if (url.includes("/api/supervisor/status")) return new Response(JSON.stringify(state({ core: 10 })), { status: 200 });
      if (url.includes("/api/operations")) return new Response("[]", { status: 200 });
      return new Response(JSON.stringify({ suggestions: [] }), { status: 200 });
    });
    renderSection();
    const [coreRestart] = await screen.findAllByRole("button", { name: "Restart" });
    fireEvent.click(coreRestart);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't restart: Supervisor not running.");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
