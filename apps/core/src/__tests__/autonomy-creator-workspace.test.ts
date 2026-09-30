import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const { fakeHome, settingsStore } = vi.hoisted(() => ({
  fakeHome: `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/talome-autonomy-home-${process.pid}-${Date.now()}`,
  settingsStore: new Map<string, string>(),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});
vi.mock("../utils/settings.js", () => ({
  getSetting: (key: string) => settingsStore.get(key),
  setSetting: (key: string, value: string) => settingsStore.set(key, value),
}));
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../creator/cli-readiness.js", () => ({ checkCreatorCliReadiness: vi.fn(async () => ({ ready: true })) }));
vi.mock("../creator/orchestrator.js", () => ({
  generateCreatorDraft: vi.fn(), getCreatorModel: vi.fn(), publishCreatorDraft: vi.fn(),
}));

import { creator, resolveCreatorWorkspace, creatorWorkspacesRoot } from "../routes/creator.js";
import {
  creatorSkipsPermissionPrompts,
  evolutionSkipsPermissionPrompts,
  CREATOR_SKIP_PROMPTS_KEY,
  EVOLUTION_SKIP_PROMPTS_KEY,
} from "../ai/autonomy.js";
import { isProtectedSettingKey } from "../ai/execution.js";

beforeEach(() => settingsStore.clear());
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe("autonomy settings (P0-5)", () => {
  it("are off unless the owner turned them on, and a request can only narrow them", () => {
    expect(creatorSkipsPermissionPrompts(true)).toBe(false);
    expect(evolutionSkipsPermissionPrompts(true)).toBe(false);

    settingsStore.set(CREATOR_SKIP_PROMPTS_KEY, "true");
    expect(creatorSkipsPermissionPrompts()).toBe(true);
    expect(creatorSkipsPermissionPrompts(false)).toBe(false);
    // Builds and evolution are separate choices.
    expect(evolutionSkipsPermissionPrompts(true)).toBe(false);

    settingsStore.set(EVOLUTION_SKIP_PROMPTS_KEY, "true");
    expect(evolutionSkipsPermissionPrompts()).toBe(true);
    settingsStore.set(EVOLUTION_SKIP_PROMPTS_KEY, "false");
    expect(evolutionSkipsPermissionPrompts(true)).toBe(false);
  });

  it("are protected from the agent's own settings tool", () => {
    expect(isProtectedSettingKey(CREATOR_SKIP_PROMPTS_KEY)).toBe(true);
    expect(isProtectedSettingKey(EVOLUTION_SKIP_PROMPTS_KEY)).toBe(true);
  });
});

async function execute(body: Record<string, unknown>) {
  const res = await creator.request("/create/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskPrompt: "Build it", appId: "my-app", ...body }),
  });
  return { status: res.status, body: await res.json() as { command?: string; error?: string; workspaceRoot?: string } };
}

describe("creator terminal launch", () => {
  it("ignores a client-sent auto flag unless the owner allowed builds without prompts", async () => {
    const off = await execute({ auto: true, yolo: true });
    expect(off.status).toBe(200);
    expect(off.body.command).not.toContain("--dangerously-skip-permissions");

    settingsStore.set(CREATOR_SKIP_PROMPTS_KEY, "true");
    const on = await execute({});
    expect(on.body.command).toContain("--dangerously-skip-permissions");
    const narrowed = await execute({ auto: false });
    expect(narrowed.body.command).not.toContain("--dangerously-skip-permissions");
  });

  it("only runs in the app's own generated workspace", async () => {
    const ok = await execute({});
    expect(ok.body.workspaceRoot).toBe(join(creatorWorkspacesRoot(), "my-app"));

    const outside = await execute({ workspaceRoot: "/etc" });
    expect(outside.status).toBe(400);
    const traversal = await execute({ workspaceRoot: join(creatorWorkspacesRoot(), "my-app", "..", "other") });
    expect(traversal.status).toBe(400);
    const badId = await execute({ appId: "../../etc" });
    expect(badId.status).toBe(400);
  });

  it("refuses a workspace symlinked outside the workspaces root", () => {
    const root = creatorWorkspacesRoot();
    mkdirSync(root, { recursive: true });
    const elsewhere = join(fakeHome, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(root, "linked-app"));
    expect(resolveCreatorWorkspace("linked-app")).toEqual({ ok: false, error: expect.stringContaining("outside") });
    expect(resolveCreatorWorkspace("my-app", join(root, "my-app"))).toEqual({ ok: true, path: join(root, "my-app") });
  });
});
