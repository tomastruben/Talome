import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ stored: vi.fn() }));

vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));
vi.mock("../stores/lifecycle.js", () => ({ uninstallApp: vi.fn() }));
vi.mock("../stores/adapters/talome-adapter.js", () => ({ talomeAdapter: {} }));
vi.mock("../app-specs/service.js", () => ({ saveAppSpec: vi.fn(), deleteAppSpec: vi.fn(), getStoredAppSpec: mocks.stored }));

import { createUserApp, type CreateAppInput } from "../stores/creator.js";
import { createDefaultAppSpec } from "../app-specs/schema.js";

describe("direct app-store publication", () => {
  it.each(["../escape", "/tmp/escape", "nested/app", "nested\\app", "..", ".", "%2e%2e%2fescape", "app\u0000name", "", "a".repeat(97)])("rejects unsafe app ID %j before filesystem or database work", (id) => {
    const input: CreateAppInput = { id, name: "Example", description: "", category: "other", services: [], env: [] };
    const result = createUserApp(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("App ID must be a slug");
  });

  it.each(["budget-compass", "app", "app-2", "7-day-planner"])("accepts the safe slug %s and proceeds to ordinary input validation", (id) => {
    const input: CreateAppInput = {
      id, name: "Example", description: "", category: "other", env: [],
      services: [{ name: "web", image: "", ports: [], volumes: [], environment: {} }],
    };
    expect(createUserApp(input).error).toContain("missing an image tag");
  });

  it.each([false, true])("cannot bypass fresh validation with generatedWithClaudeCode=%s", (generatedWithClaudeCode) => {
    const input = {
      id: "untrusted-workspace", name: "Untrusted", description: "", category: "other", services: [], env: [],
      creator: {
        workspace: { scaffoldPath: "/fake/scaffold", generatedWithClaudeCode },
        validations: [{ id: "native-browser", status: "passed", evidencePath: "/fake/report.json" }],
      },
    } as unknown as CreateAppInput;
    const result = createUserApp(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain("validated first");
  });

  it("rejects a concurrent native revision before modifying app files", () => {
    const snapshot = mkdtempSync(join(tmpdir(), "talome-revision-boundary-"));
    try {
      const spec = { ...createDefaultAppSpec({ appId: "versioned-app", name: "Versioned", description: "A test app" }), revision: 2 };
      writeFileSync(join(snapshot, "talome-app.json"), JSON.stringify(spec));
      mocks.stored.mockReturnValue({ revision: 2 });
      const input = {
        id: "versioned-app", name: "Versioned", description: "A test app", category: "other", services: [], env: [],
        creator: { blueprint: { appSpec: spec }, workspace: { scaffoldPath: "/original" }, validations: [] },
      } as unknown as CreateAppInput;
      const result = createUserApp(input, { validatedScaffoldPath: snapshot });
      expect(result.success).toBe(false);
      expect(result.error).toContain("changed after validation");
    } finally {
      mocks.stored.mockReset();
      rmSync(snapshot, { recursive: true, force: true });
    }
  });
});
