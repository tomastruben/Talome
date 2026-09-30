import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inFlightConsequence,
  inFlightScope,
  processDotState,
  restartSettled,
  restartTargets,
  runVerifiedRestart,
  type InFlightWork,
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
    signal: overrides.signal,
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

  const idle: InFlightWork = { operations: [], evolutionRuns: 0, assistantReplying: false, terminalSessions: [], unknown: false };

  it("describes what a restart interrupts, and admits when it couldn't check", () => {
    expect(inFlightConsequence(idle, "core")).toBeNull();
    expect(inFlightConsequence({ ...idle, operations: ["Updating jellyfin", "Backing up immich", "Installing sonarr"], evolutionRuns: 1, assistantReplying: true }, "core"))
      .toBe("Restarting Core interrupts Updating jellyfin, Backing up immich and 1 more, a self-improvement run and the Assistant's reply.");
    expect(inFlightConsequence({ ...idle, unknown: true }, "all"))
      .toBe("Restarting every service may interrupt running work: Talome couldn't check what is running.");
    expect(inFlightConsequence({ ...idle, terminalSessions: ["default", "Evolution · Sep 30, 2:30pm", "App: notes"] }, "terminal_daemon"))
      .toBe("Restarting Terminal interrupts 3 terminal sessions (default, Evolution · Sep 30, 2:30pm and 1 more).");
  });

  it("checks only the work each service can interrupt", () => {
    // Operations, self-improvement and the Assistant run in core; the terminal daemon owns the sessions.
    expect(inFlightScope("core")).toEqual({ core: true, terminal: false });
    expect(inFlightScope("terminal_daemon")).toEqual({ core: false, terminal: true });
    expect(inFlightScope("dashboard")).toEqual({ core: false, terminal: false });
    expect(inFlightScope("all")).toEqual({ core: true, terminal: true });
  });

  it("verifies a dashboard or full restart whose request died with the proxy (regression)", async () => {
    // Core SIGKILLs the dashboard that proxies the request before it answers.
    const before = state({ core: 1, dashboard: 2, terminal_daemon: 3 });
    const dashboard = await runVerifiedRestart("dashboard", before, deps({
      request: async () => { throw new TypeError("Failed to fetch"); },
      statuses: [null, state({ core: 1, dashboard: 12, terminal_daemon: 3 })],
    }));
    expect(dashboard).toEqual({ ok: true });
    const all = await runVerifiedRestart("all", before, deps({
      request: async () => new Response("Bad gateway", { status: 502 }),
      statuses: [null, state({ core: 11, dashboard: 12, terminal_daemon: 13 })],
    }));
    expect(all).toEqual({ ok: true });
    // A restart that never happened still ends in "couldn't confirm", never in success.
    const never = await runVerifiedRestart("dashboard", before, deps({
      request: async () => { throw new TypeError("Failed to fetch"); },
      statuses: [before],
    }), { pollMs: 1000, timeoutMs: 3000 });
    expect(never).toEqual({ ok: false, reason: "timeout" });
    // Core's own request doesn't die with the restart: a failure there is a failure.
    const core = await runVerifiedRestart("core", before, deps({ request: async () => { throw new TypeError("Failed to fetch"); } }));
    expect(core).toMatchObject({ ok: false, reason: "request" });
  });

  it("restart all waits only for the processes the supervisor runs", () => {
    expect(restartTargets("all", state({ core: 1, terminal_daemon: 3 }))).toEqual(["core", "terminal_daemon"]);
    expect(restartTargets("all", null)).toEqual(["core", "dashboard", "terminal_daemon"]);
    expect(restartTargets("terminal_daemon", state({ core: 1 }))).toEqual(["terminal_daemon"]);
  });

  it("stops polling when cancelled", async () => {
    const controller = new AbortController();
    let polls = 0;
    const outcome = await runVerifiedRestart("core", state({ core: 1 }), deps({
      readStatus: async () => {
        polls += 1;
        if (polls === 2) controller.abort();
        return state({ core: 1 });
      },
      signal: controller.signal,
    }));
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(polls).toBe(2);
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

  function route(handlers: { operations?: unknown; evolution?: unknown; sessions?: unknown }) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/supervisor/status")) return new Response(JSON.stringify(state({ core: 10, dashboard: 20, terminal_daemon: 30 })), { status: 200 });
      if (url.includes("/api/operations")) return new Response(JSON.stringify(handlers.operations ?? []), { status: 200 });
      if (url.includes("/api/evolution/suggestions")) return new Response(JSON.stringify(handlers.evolution ?? { suggestions: [] }), { status: 200 });
      if (url.includes("/api/terminal/sessions")) return new Response(JSON.stringify(handlers.sessions ?? { sessions: [] }), { status: 200 });
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

  const posts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/restart") && init?.method === "POST");

  it("doesn't ask about app operations before restarting the dashboard (they run in core)", async () => {
    route({
      operations: [{
        id: "op1", appId: "jellyfin", kind: "update", actor: "user", status: "running", step: null, progress: 0.4,
        detail: null, error: null, startedAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T10:00:05Z", finishedAt: null,
      }],
    });
    renderSection();
    const [, dashboardRestart] = await screen.findAllByRole("button", { name: "Restart" });
    fireEvent.click(dashboardRestart);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/operations"))).toBe(false);
  });

  it("names the terminal sessions a terminal restart would kill", async () => {
    route({ sessions: { sessions: [{ id: "sess_talome-claude", name: "talome-claude", displayName: "Claude Code" }] } });
    mocks.confirm.mockResolvedValue({ confirmed: false, optionChecked: false });
    renderSection();
    const [, , terminalRestart] = await screen.findAllByRole("button", { name: "Restart" });
    fireEvent.click(terminalRestart);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.confirm.mock.calls[0][0]).toMatchObject({
      title: "Restart Terminal now?",
      consequence: "Restarting Terminal interrupts 1 terminal session (Claude Code).",
    });
    expect(posts()).toHaveLength(0);
  });

  it("sends one restart for a double click while the in-flight check runs (regression)", async () => {
    route({});
    renderSection();
    const [coreRestart] = await screen.findAllByRole("button", { name: "Restart" });
    fireEvent.click(coreRestart);
    fireEvent.click(coreRestart);
    await waitFor(() => expect(posts()).toHaveLength(1));
    // Give a second click every chance to have sent its own request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts()).toHaveLength(1);
  });

  it("keeps the section and says so when the supervisor status is unavailable", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "Supervisor not running" }), { status: 404 }));
    renderSection();
    expect(await screen.findByText(/Status unavailable/)).toBeInTheDocument();
    expect(document.getElementById("services")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
