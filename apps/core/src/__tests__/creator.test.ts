import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockDbGet = vi.hoisted(() => vi.fn());
const mockDiscoverSources = vi.hoisted(() => vi.fn());
const mockRenderSourceContext = vi.hoisted(() => vi.fn());
const mockExecuteWorkspaceGeneration = vi.hoisted(() => vi.fn());
const mockConfiguredModel = vi.hoisted(() => vi.fn(() => ({ provider: "openai", modelId: "gpt-user-choice", model: { modelId: "gpt-user-choice" } })));
vi.mock("../ai/configured-model.js", () => ({ getConfiguredModel: mockConfiguredModel }));

const mockValidateDesignArtifacts = vi.hoisted(() => vi.fn(async () => []));
const mockCreateUserApp = vi.hoisted(() => vi.fn());
const mockValidateGeneratedApp = vi.hoisted(() => vi.fn());
vi.mock("../creator/completion-validation.js", () => ({ validateGeneratedApp: mockValidateGeneratedApp }));
vi.mock("../creator/browser-validation.js", () => ({ validateNativeAppInBrowser: vi.fn(async () => [{ id: "native-browser", status: "passed", label: "Fresh native fixture evidence" }]) }));
vi.mock("../creator/workspace-snapshot.js", () => ({ snapshotGeneratedWorkspace: vi.fn(async (source: string) => source), snapshotNativeContract: vi.fn(async () => "/tmp/native-contract-fixture") }));
vi.mock("../creator/publication-contract.js", () => ({ preparePublicationContract: vi.fn((_path, _id, spec) => spec) }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn<typeof actual.writeFileSync>((file, data, options) => {
    if (file === "/tmp/test-workspace/.talome-creator/creator-draft.json") return;
    return actual.writeFileSync(file, data, options);
  }) };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: mockGenerateObject };
});

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn()),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ get: mockDbGet }),
      }),
    }),
  },
  schema: {
    settings: { key: "key" },
    appCatalog: {
      name: "name",
      appId: "app_id",
      tagline: "tagline",
      description: "description",
      storeSourceId: "store_source_id",
    },
  },
}));

vi.mock("../creator/instructions.js", () => ({
  loadInstructionPack: vi.fn(async () => ({
    summary: {
      version: "app-creation:test-pack",
      hash: "test-pack",
      files: ["system.md", "docker.md"],
    },
    documents: {
      "system.md": "system",
      "docker.md": "docker",
    },
  })),
  renderInstructionPack: vi.fn(() => "instruction-pack"),
  loadTalomeReferenceSnapshots: vi.fn(async () => [
    {
      title: "Create App Page",
      reason: "reference",
      sourcePath: "/repo/apps/dashboard/src/app/dashboard/apps/create/page.tsx",
      relativePath: "apps/dashboard/src/app/dashboard/apps/create/page.tsx",
      content: "export default function CreateAppPage() {}",
    },
  ]),
}));

vi.mock("../creator/source-discovery.js", () => ({
  discoverSources: mockDiscoverSources,
  renderSourceContext: mockRenderSourceContext,
}));

vi.mock("../creator/workspace-executor.js", () => ({
  executeWorkspaceGeneration: mockExecuteWorkspaceGeneration,
  validateDesignArtifacts: mockValidateDesignArtifacts,
  prepareWorkspace: vi.fn().mockReturnValue({
    taskPrompt: "test prompt",
    workspaceRoot: "/tmp/test-workspace",
    scaffoldPath: "/tmp/test-workspace/generated-app",
    sourceSnapshots: [],
    designArtifacts: [],
  }),
}));

vi.mock("../stores/creator.js", () => ({
  createUserApp: mockCreateUserApp,
}));

vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));

const SAMPLE_BLUEPRINT = {
  id: "my-postgres",
  name: "My Postgres",
  description: "A PostgreSQL database",
  prompt: "A PostgreSQL database",
  category: "developer",
  sourceReferences: [],
  research: {
    useCases: [
      {
        id: "manage-database",
        title: "Manage the database",
        userGoal: "See whether PostgreSQL is healthy",
        outcome: "Resolve database issues from Talome",
        frequency: "daily",
      },
    ],
    githubQueries: ["postgres self hosted admin dashboard github"],
    patternQuestions: ["How do database tools surface health and recovery actions?"],
    libraryNeeds: [],
  },
  experienceDesign: {
    primaryUseCaseId: "manage-database",
    workflows: [
      {
        id: "review-health",
        name: "Review health",
        useCaseId: "manage-database",
        outcome: "Know whether PostgreSQL needs attention",
        steps: ["Open overview", "Review health", "Run a recovery action if needed"],
      },
    ],
    screens: [
      {
        id: "dashboard",
        name: "Database overview",
        useCaseIds: ["manage-database"],
        job: "Understand current database health",
        primaryAction: "Inspect the active issue",
        pattern: "Operational status overview",
        componentCandidates: ["stat", "actions"],
        states: ["default", "loading", "error", "compact-window"],
      },
    ],
    visualDirection: {
      mode: "native-system",
      summary: "A calm Talome-native operational view",
      layout: "Single task-first overview",
      signatureElements: ["large app icon"],
      motion: ["restrained transitions"],
    },
  },
  services: [
    {
      name: "postgres",
      image: "postgres:16-alpine",
      ports: [{ host: 5432, container: 5432 }],
      volumes: [{ hostPath: "./data", containerPath: "/var/lib/postgresql/data" }],
      environment: { POSTGRES_PASSWORD: "changeme", PUID: "1000", PGID: "1000" },
    },
  ],
  env: [
    { key: "POSTGRES_PASSWORD", label: "Postgres Password", required: true, secret: true },
  ],
  scaffold: {
    enabled: true,
    kind: "full-stack",
    framework: "next.js",
    runtime: "node",
    packageManager: "pnpm",
    outputDir: "generated-app",
    entryFiles: [],
  },
  ui: {
    surfaces: ["dashboard"],
    preferredBlocks: ["login"],
    designConstraints: ["Use Talome spacing"],
    references: [
      {
        title: "Create App Page",
        path: "apps/dashboard/src/app/dashboard/apps/create/page.tsx",
        reason: "Match Talome layout",
      },
    ],
  },
  successCriteria: ["Valid compose", "Talome-aligned UI"],
  designAlignment: {
    summary: "Matches Talome's visual language.",
    referencePaths: ["apps/dashboard/src/app/dashboard/apps/create/page.tsx"],
    notes: ["Use Talome spacing"],
  },
  instructionsVersion: "app-creation:test-pack",
};

describe("creator orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateGeneratedApp.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockDbGet.mockReturnValue(null);
    mockDiscoverSources.mockReturnValue([
      {
        kind: "existing-store-app",
        label: "Postgres",
        appId: "postgres",
        storeId: "talome-community",
      },
    ]);
    mockRenderSourceContext.mockReturnValue("source-context");
    mockGenerateObject.mockResolvedValue({ object: SAMPLE_BLUEPRINT });
    mockExecuteWorkspaceGeneration.mockResolvedValue({
      workspace: {
        appId: "my-postgres",
        rootPath: "/tmp/generated/my-postgres",
        scaffoldPath: "/tmp/generated/my-postgres/generated-app",
        fileCount: 3,
        entryFiles: ["generated-app/app/page.tsx"],
        sourceSnapshots: ["sources/postgres"],
        generatedWithClaudeCode: true,
      },
      validations: [
        {
          id: "claude-execution",
          label: "Claude Code workspace run",
          status: "passed",
          details: "3 file(s) changed",
        },
      ],
    });
    mockCreateUserApp.mockReturnValue({
      success: true,
      appId: "my-postgres",
      storeId: "user-apps",
    });
  });

  it("uses the selected provider model with a locally validated flexible OpenAI contract", async () => {
    const { generateCreatorDraft } = await import("../creator/orchestrator.js");
    await generateCreatorDraft({ description: "Analytics", mode: "both", saveImmediately: false, source: { kind: "scratch" } });
    expect(mockGenerateObject).toHaveBeenCalledWith(expect.objectContaining({
      model: { modelId: "gpt-user-choice" },
      schema: expect.any(Object),
      providerOptions: { openai: { strictJsonSchema: false } },
    }));
  });

  it("creates a draft with sources, validations, and workspace metadata", async () => {
    const { generateCreatorDraft } = await import("../creator/orchestrator.js");
    const draft = await generateCreatorDraft(
      {
        description: "A PostgreSQL database",
        mode: "both",
        saveImmediately: false,
        source: { kind: "auto" },
      },
      "test-key",
    );

    expect(draft.app.id).toBe("my-postgres");
    expect(draft.sources).toHaveLength(1);
    expect(draft.workspace).toBeDefined();
    expect(draft.validations).toBeDefined();
  });

  it("reruns independent validation before publishing a completed draft", async () => {
    const { generateCreatorDraft, publishCreatorDraft } = await import("../creator/orchestrator.js");
    const draft = await generateCreatorDraft({ description: "Database", mode: "both", saveImmediately: false, source: { kind: "auto" } }, "test-key");
    const root = await mkdtemp(join(tmpdir(), "talome-publish-completed-"));
    try {
      draft.workspace!.scaffoldPath = root;
      draft.workspace!.generatedWithClaudeCode = true;
      await writeFile(join(root, "server.py"), "print('application entry')\n");
      mockValidateGeneratedApp.mockResolvedValueOnce({ validations: [{ id: "native-browser", status: "failed", label: "Native browser", details: "Fresh browser check failed" }] });
      await expect(publishCreatorDraft(draft)).rejects.toThrow("Fresh browser check failed");
      expect(mockValidateGeneratedApp).toHaveBeenCalledOnce();
      expect(mockCreateUserApp).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not let a false provenance flag bypass validation of an implemented workspace", async () => {
    const { generateCreatorDraft, publishCreatorDraft } = await import("../creator/orchestrator.js");
    const draft = await generateCreatorDraft({ description: "Database", mode: "both", saveImmediately: false, source: { kind: "auto" } }, "test-key");
    const root = await mkdtemp(join(tmpdir(), "talome-publish-provenance-"));
    try {
      draft.workspace!.scaffoldPath = root;
      draft.workspace!.generatedWithClaudeCode = false;
      await writeFile(join(root, "docker-compose.yml"), "services: {}\n");
      await writeFile(join(root, "server.py"), "print('application entry')\n");
      mockValidateGeneratedApp.mockResolvedValueOnce({ validations: [{ id: "native-browser", status: "failed", label: "Native browser", details: "Current render failed" }] });
      await expect(publishCreatorDraft(draft)).rejects.toThrow("Current render failed");
      expect(mockValidateGeneratedApp).toHaveBeenCalledOnce();
      expect(mockCreateUserApp).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not let an omitted workspace bypass native browser validation", async () => {
    const { generateCreatorDraft, publishCreatorDraft } = await import("../creator/orchestrator.js");
    const { validateNativeAppInBrowser } = await import("../creator/browser-validation.js");
    const draft = await generateCreatorDraft({ description: "Database", mode: "both", saveImmediately: false, source: { kind: "auto" } }, "test-key");
    draft.workspace = undefined;
    draft.blueprint.scaffold.enabled = false;
    vi.mocked(validateNativeAppInBrowser).mockResolvedValueOnce([{ id: "native-browser", label: "Browser", status: "failed", details: "No browser executable" }]);
    await expect(publishCreatorDraft(draft)).rejects.toThrow("No browser executable");
    expect(mockCreateUserApp).not.toHaveBeenCalled();
  });

  it("rejects a prepared full-app draft even when caller claims generation succeeded", async () => {
    const { generateCreatorDraft, publishCreatorDraft } = await import("../creator/orchestrator.js");
    const draft = await generateCreatorDraft({ description: "Analytics", mode: "both", saveImmediately: false, source: { kind: "scratch" } });
    const root = await mkdtemp(join(tmpdir(), "talome-pending-scaffold-"));
    try {
      draft.workspace!.scaffoldPath = root;
      await writeFile(join(root, "talome-app.json"), JSON.stringify(draft.blueprint.appSpec));
      for (const claimed of [false, true]) {
        draft.workspace!.generatedWithClaudeCode = claimed;
        await expect(publishCreatorDraft(draft)).rejects.toThrow("beyond deployment metadata");
      }
      await writeFile(join(root, "docker-compose.yml"), "services: {}\n");
      await writeFile(join(root, "manifest.json"), "{}");
      await expect(publishCreatorDraft(draft)).rejects.toThrow("beyond deployment metadata");
      draft.workspace = undefined;
      await expect(publishCreatorDraft(draft)).rejects.toThrow("completed generated workspace");
      expect(mockCreateUserApp).not.toHaveBeenCalled();
      expect(mockValidateGeneratedApp).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("revalidates staged design artifacts for implemented full apps before publishing", async () => {
    const { generateCreatorDraft, publishCreatorDraft } = await import("../creator/orchestrator.js");
    const draft = await generateCreatorDraft({ description: "Analytics", mode: "both", saveImmediately: false, source: { kind: "scratch" } });
    const root = await mkdtemp(join(tmpdir(), "talome-pending-design-"));
    try {
      draft.workspace!.scaffoldPath = root;
      await writeFile(join(root, "server.py"), "print('application entry')\n");
      mockValidateGeneratedApp.mockResolvedValueOnce({ validations: [{ id: "native-browser", label: "Browser", status: "passed" }] });
      mockValidateDesignArtifacts.mockResolvedValueOnce([{ id: "screen-spec", label: "Screen spec", status: "failed", details: "Design artifacts remain pending" }] as never);
      await expect(publishCreatorDraft(draft)).rejects.toThrow("Design artifacts remain pending");
      expect(mockCreateUserApp).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("publishes the generated contract even when a headless caller retains the initial blueprint", async () => {
    const { generateCreatorDraft, publishCreatorDraft } = await import("../creator/orchestrator.js");
    const draft = await generateCreatorDraft({ description: "Database", mode: "both", saveImmediately: false, source: { kind: "auto" } }, "test-key");
    const root = await mkdtemp(join(tmpdir(), "talome-publish-contract-"));
    try {
      const spec = structuredClone(draft.blueprint.appSpec!);
      spec.actions.push({ id: "new-action", kind: "assistant", label: "New action", description: "A newly implemented action.", prompt: "Run the new workflow." });
      spec.assistant.exposedActions.push("new-action");
      await writeFile(join(root, "talome-app.json"), JSON.stringify(spec));
      draft.workspace!.scaffoldPath = root;
      await writeFile(join(root, "server.py"), "print('application entry')\n");
      mockValidateGeneratedApp.mockResolvedValueOnce({ appSpec: spec, validations: [{ id: "generated-compose", label: "Fresh validation", status: "passed" }] });
      await publishCreatorDraft(draft);
      expect(mockCreateUserApp).toHaveBeenCalledWith(expect.objectContaining({ creator: expect.objectContaining({ blueprint: expect.objectContaining({ appSpec: spec }) }) }), { validatedScaffoldPath: root });
      // An invalid generated file must fail before publishing, not silently fall back.
      mockCreateUserApp.mockClear();
      await writeFile(join(root, "talome-app.json"), JSON.stringify({ ...spec, appId: "wrong-app" }));
      await expect(publishCreatorDraft(draft)).rejects.toThrow("AppSpec appId must be my-postgres");
      expect(mockCreateUserApp).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
