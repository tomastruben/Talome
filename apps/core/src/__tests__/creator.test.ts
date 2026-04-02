import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockDbGet = vi.hoisted(() => vi.fn());
const mockDiscoverSources = vi.hoisted(() => vi.fn());
const mockRenderSourceContext = vi.hoisted(() => vi.fn());
const mockExecuteWorkspaceGeneration = vi.hoisted(() => vi.fn());
const mockCreateUserApp = vi.hoisted(() => vi.fn());

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
  prepareWorkspace: vi.fn().mockReturnValue({
    taskPrompt: "test prompt",
    workspaceRoot: "/tmp/test-workspace",
    scaffoldPath: "/tmp/test-workspace/generated-app",
    sourceSnapshots: [],
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

});
