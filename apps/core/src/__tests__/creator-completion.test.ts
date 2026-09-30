import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultAppSpec } from "../app-specs/schema.js";
import { validateGeneratedApp } from "../creator/completion-validation.js";
import { completeWorkspace } from "../creator/workspace-executor.js";
import { AppBlueprintSchema } from "../creator/contracts.js";
import { validateNativeAppInBrowser } from "../creator/browser-validation.js";

const { publish, runCommand, cliReadiness } = vi.hoisted(() => ({
  cliReadiness: vi.fn(async () => ({ ready: true })),
  publish: vi.fn(() => ({ success: true, appId: "test-app", storeId: "user-apps" })),
  runCommand: vi.fn(async () => {}),
}));
vi.mock("../creator/orchestrator.js", () => ({
  generateCreatorDraft: vi.fn(), getCreatorModel: vi.fn(() => { throw new Error("AI_PROVIDER_NOT_CONFIGURED: No configured provider credentials."); }), publishCreatorDraft: vi.fn(),
}));
vi.mock("../creator/cli-readiness.js", () => ({ checkCreatorCliReadiness: cliReadiness }));
vi.mock("../stores/creator.js", () => ({ createUserApp: publish }));
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../app-specs/service.js", () => ({ getStoredAppSpec: vi.fn(() => null) }));
vi.mock("../creator/workspace-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../creator/workspace-snapshot.js")>();
  return { snapshotGeneratedWorkspace: async (source: string) => {
    const snapshot = await actual.snapshotGeneratedWorkspace(source, tmpdir());
    roots.push(join(snapshot, ".."));
    return snapshot;
  } };
});
vi.mock("../creator/browser-validation.js", () => ({ validateNativeAppInBrowser: vi.fn(async () => [
  { id: "native-browser", label: "Native fixture", status: "passed", scope: "native-renderer-fixture" },
  { id: "app-runtime", label: "App service", status: "skipped", scope: "app-runtime" },
]) }));
vi.mock("../creator/completion-validation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../creator/completion-validation.js")>();
  return { ...original, validateGeneratedApp: (...args: Parameters<typeof original.validateGeneratedApp>) => original.validateGeneratedApp(args[0], args[1], args[2], args[3] ?? runCommand) };
});
import { creator } from "../routes/creator.js";
import { generateCreatorDraft, publishCreatorDraft } from "../creator/orchestrator.js";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "talome-completion-"));
  roots.push(root);
  await mkdir(join(root, "generated-app"));
  return root;
}
async function compose(root: string) {
  await writeFile(join(root, "generated-app", "docker-compose.yml"), "services:\n  app:\n    image: python:3.12-alpine\n");
}
async function complete(root: string) {
  const response = await creator.request("/create/complete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "test-app", workspaceRoot: root }),
  });
  return response.json();
}
beforeEach(() => { vi.clearAllMocks(); runCommand.mockResolvedValue(undefined); vi.mocked(generateCreatorDraft).mockResolvedValue({ blueprint: { scaffold: { enabled: false } } } as never); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("generated app completion", () => {
  it("defers saveImmediately for a scaffold-enabled draft instead of publishing a prepared shell", async () => {
    vi.mocked(generateCreatorDraft).mockResolvedValueOnce({ app: { id: "test-app" }, blueprint: { scaffold: { enabled: true } } } as never);
    const response = await creator.request("/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: "Build analytics", saveImmediately: true, preBuiltBlueprint: { identity: { name: "Analytics" }, services: [{ name: "app", image: "node:22-alpine" }] } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pending: true, draft: { app: { id: "test-app" } } });
    expect(publishCreatorDraft).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains immediate publication for explicit non-scaffold drafts without checking CLI login", async () => {
    const draft = { app: { id: "test-app" }, blueprint: { scaffold: { enabled: false } } };
    vi.mocked(generateCreatorDraft).mockResolvedValueOnce(draft as never);
    vi.mocked(publishCreatorDraft).mockResolvedValueOnce({ success: true, appId: "test-app", storeId: "user-apps" });
    const response = await creator.request("/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: "Native analytics", mode: "docker-only", saveImmediately: true, preBuiltBlueprint: { identity: { name: "Analytics" }, services: [{ name: "app", image: "nginx:alpine" }] } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, appId: "test-app" });
    expect(publishCreatorDraft).toHaveBeenCalledWith(draft);
    expect(cliReadiness).not.toHaveBeenCalled();
  });

  it("publishes a newly completed workspace without an initial installed app and preserves prepared metadata", async () => {
    const root = await workspace(); await compose(root);
    const spec = createDefaultAppSpec({ appId: "test-app", name: "Test", description: "Test app." });
    const blueprint = AppBlueprintSchema.parse({ id: "test-app", name: "Test", description: "Test app.", prompt: "Build Test", category: "other", services: [{ name: "app", image: "python:3.12-alpine" }], env: [{ key: "TIME_ZONE", label: "Time zone", required: false, default: "UTC" }], scaffold: { enabled: true }, ui: {}, designAlignment: { summary: "Talome" }, instructionsVersion: "test-pack", appSpec: spec });
    const internal = join(root, ".talome-creator");
    for (const dir of ["research", "design", "validation"]) await mkdir(join(internal, dir), { recursive: true });
    await writeFile(join(internal, "blueprint.json"), JSON.stringify(blueprint));
    await writeFile(join(internal, "creator-draft.json"), JSON.stringify({ app: blueprint, blueprint, sources: [{ kind: "public-doc", label: "Fixture documentation" }], validations: [{ id: "forged-marker", label: "Caller claim", status: "passed" }], instructionPack: { version: "test-pack", hash: "test-hash", files: ["system.md"] }, createdAt: "2026-01-01T00:00:00Z" }));
    await writeFile(join(root, "generated-app", "talome-app.json"), JSON.stringify(spec));
    await writeFile(join(internal, "research", "findings.md"), "Status: complete\n| Candidate | Exact URL/ref | License | Maintenance evidence | Talome fit | Decision | Reusable part |\n| --- | --- | --- | --- | --- | --- | --- |\n| Fixture | https://example.test/source | MIT | test-only | local | adapt | fixture |\n");
    await writeFile(join(internal, "design", "screen-spec.md"), "Status: complete\nTest-only screen specification with default, empty, error and compact states.");
    await writeFile(join(internal, "validation", "report.md"), "Status: complete\n| Check | Reference | Render | Result |\n| --- | --- | --- | --- |\n| 1 | hierarchy | fixture | pass |\n| 2 | typography | fixture | pass |\n| 3 | layout | fixture | pass |\n| 4 | dark mode compact | fixture | pass |\n| 5 | interaction | fixture | pass |\n");
    // A draft plus Compose/manifest is still not an implementation.
    expect((await complete(root)).ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    await writeFile(join(root, "generated-app", "server.py"), "print('test-only application entry')");
    const result = await complete(root);
    expect(result.ok).toBe(true);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ env: blueprint.env, creator: expect.objectContaining({ instructionPack: { version: "test-pack", hash: "test-hash", files: ["system.md"] }, sources: [{ kind: "public-doc", label: "Fixture documentation" }], createdAt: "2026-01-01T00:00:00Z", validations: expect.not.arrayContaining([expect.objectContaining({ id: "forged-marker" })]) }) }), { validatedScaffoldPath: expect.any(String) });
    // Completing an existing workspace uses the same fresh checks, not a seed publication.
    expect((await complete(root)).ok).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("returns an explicit scaffold blocker before starting a terminal when CLI login is unavailable", async () => {
    cliReadiness.mockResolvedValueOnce({ ready: false, error: "Claude Code subscription login is not active." } as never);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const response = await creator.request("/create/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId: "fixture", taskPrompt: "Create the app" }) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ stage: "scaffold", generated: false });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it("blocks publication for an unsupported declared runtime probe", async () => {
    const root = await workspace();
    await compose(root);
    await writeFile(join(root, "generated-app", "talome-app.json"), JSON.stringify(createDefaultAppSpec({ appId: "test-app", name: "Test", description: "Test app." })));
    await writeFile(join(root, "generated-app", "talome-runtime-probe.json"), JSON.stringify({ version: 1, adapter: "unreviewed-backend" }));
    const result = await complete(root);
    expect(result.ok).toBe(false);
    expect(result.validations.filter((check: { id: string }) => check.id === "app-runtime")).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks publication when independent browser validation fails", async () => {
    const root = await workspace();
    await compose(root);
    await writeFile(join(root, "generated-app", "talome-app.json"), JSON.stringify(createDefaultAppSpec({ appId: "test-app", name: "Test", description: "Test app." })));
    vi.mocked(validateNativeAppInBrowser).mockResolvedValueOnce([{ id: "native-browser", label: "Native fixture", status: "failed", details: "Primary surface rendered blank" }]);
    const result = await complete(root);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rendered blank");
    expect(publish).not.toHaveBeenCalled();
  });

  it("exposes the same composition catalog to creation agents", async () => {
    const response = await creator.request("/design-patterns?intent=stopwatch%20pause");
    expect(response.status).toBe(200);
    const kit = await response.json();
    expect(kit.version).toBe("talome-patterns:2");
    expect(kit.patterns[0].id).toBe("focused-task");
    expect(kit.patterns[0].requiredStates).toContain("running");
  });
  it("allows an already designed blueprint without an API key, while requiring a key for AI planning", async () => {
    const request = (body: unknown) => creator.request("/create", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await request({ description: "Create a timer" })).status).toBe(503);
    const response = await request({ description: "Create a timer", preBuiltBlueprint: {
      identity: { name: "Timer" }, services: [{ name: "timer", image: "python:3.12-alpine" }],
    } });
    expect(response.status).toBe(200);
    expect(generateCreatorDraft).toHaveBeenCalledWith(expect.objectContaining({ preBuiltBlueprint: expect.any(Object) }));
  });

  it("does not report success or publish a missing scaffold or manifest-only app", async () => {
    const root = await workspace();
    expect((await complete(root)).ok).toBe(false);
    await writeFile(join(root, "generated-app", "manifest.json"), JSON.stringify({ name: "Test" }));
    const result = await complete(root);
    expect(result.ok).toBe(false);
    expect(result.validations[0].status).toBe("failed");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects malformed and unrunnable compose before publishing", async () => {
    const root = await workspace();
    await writeFile(join(root, "generated-app", "docker-compose.yml"), "services: {}\n");
    expect((await complete(root)).ok).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    await compose(root);
    runCommand.mockRejectedValueOnce(new Error("service app refers to undefined network missing"));
    const result = await complete(root);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("undefined network");
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains the generated native action contract and executed validation results for Python apps", async () => {
    const root = await workspace();
    await compose(root);
    const spec = createDefaultAppSpec({ appId: "test-app", name: "Test", description: "Test app." });
    spec.actions.push({ id: "record-lap", kind: "app-api", appId: "test-app", method: "POST", path: "/api/laps", label: "Record lap", description: "Record the current lap." });
    spec.assistant.exposedActions.push("record-lap");
    await writeFile(join(root, "generated-app", "talome-app.json"), JSON.stringify(spec));
    await writeFile(join(root, "generated-app", "server.py"), "print('hello')");
    const result = await complete(root);
    expect(result.ok).toBe(true);
    expect(result.validations.filter((check: { id: string }) => check.id === "app-runtime")).toEqual([expect.objectContaining({ status: "skipped", details: expect.stringContaining("No supported runtime probe declared") })]);
    expect(runCommand).toHaveBeenCalledWith("docker", ["compose", "-f", "docker-compose.yml", "config", "--quiet"], expect.stringContaining("/run-"));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ creator: expect.objectContaining({
      blueprint: expect.objectContaining({ appSpec: spec }),
      validations: expect.arrayContaining([expect.objectContaining({ id: "generated-compose", status: "passed" })]),
    }) }), { validatedScaffoldPath: expect.stringContaining("/run-") });
  });

  it("rejects invalid generated AppSpecs even when a valid initial blueprint exists", async () => {
    const root = await workspace();
    await compose(root);
    const spec = createDefaultAppSpec({ appId: "test-app", name: "Test", description: "Test app." });
    await writeFile(join(root, "generated-app", "talome-app.json"), JSON.stringify({ ...spec, appId: "wrong-app" }));
    const result = await validateGeneratedApp(join(root, "generated-app"), "test-app", { appSpec: spec });
    expect(result.validations.find((check) => check.id === "app-spec")?.status).toBe("failed");
    expect(result.appSpec).toBeUndefined();
  });

  it("requires a native contract for staged creations while preserving true legacy workspaces", async () => {
    const root = await workspace();
    await compose(root);
    const staged = await validateGeneratedApp(join(root, "generated-app"), "test-app", { research: {}, experienceDesign: {} });
    expect(staged.validations.find((check) => check.id === "app-spec")?.status).toBe("failed");
    const legacy = await validateGeneratedApp(join(root, "generated-app"), "test-app", {});
    expect(legacy.validations.find((check) => check.id === "app-spec")?.status).toBe("skipped");
  });

  it("returns an updated blueprint from headless workspace completion", async () => {
    const root = await workspace();
    await compose(root);
    await mkdir(join(root, ".talome-creator", "runs"), { recursive: true });
    const original = createDefaultAppSpec({ appId: "test-app", name: "Test", description: "Test app." });
    const generated = structuredClone(original);
    generated.revision = 2;
    generated.actions.push({ id: "new-action", kind: "assistant", label: "New", description: "New workflow.", prompt: "Run the new workflow." });
    await writeFile(join(root, "generated-app", "talome-app.json"), JSON.stringify(generated));
    const blueprint = AppBlueprintSchema.parse({ id: "test-app", name: "Test", description: "Test app.", prompt: "Build Test", category: "other", services: [{ name: "app", image: "python:3.12-alpine" }], scaffold: {}, ui: {}, designAlignment: { summary: "Talome" }, instructionsVersion: "test", appSpec: original });
    const result = await completeWorkspace({ workspaceRoot: root, scaffoldPath: join(root, "generated-app"), taskPrompt: "", sourceSnapshots: [], designArtifacts: [], beforeSnapshot: [] }, blueprint, blueprint);
    expect(result.blueprint.appSpec).toEqual(generated);
    expect(blueprint.appSpec).toEqual(original);
  });

  it("typechecks nested UI packages using their installed compiler and propagates failures", async () => {
    const root = await workspace();
    await compose(root);
    const ui = join(root, "generated-app", "ui");
    await mkdir(join(ui, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(ui, "package.json"), JSON.stringify({ devDependencies: { typescript: "5.9.3" } }));
    await writeFile(join(ui, "tsconfig.json"), "{}");
    await writeFile(join(ui, "node_modules", ".bin", "tsc"), "compiler placeholder for test");
    runCommand.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Type mismatch"));
    const result = await complete(root);
    expect(result.ok).toBe(false);
    expect(result.validations.find((check: { id: string }) => check.id === "typescript:ui/package.json").details).toContain("Type mismatch");
    expect(result.filesGenerated).not.toContain("ui/node_modules/.bin/tsc");
    expect(publish).not.toHaveBeenCalled();
  });
});
