import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const constructors = vi.hoisted(() => ({ anthropic: vi.fn(), openai: vi.fn(), chat: vi.fn() }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: (options: unknown) => (model: string) => {
  constructors.anthropic(options, model); return { provider: "anthropic", modelId: model };
} }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: (options: unknown) => Object.assign((model: string) => {
  constructors.openai(options, model); return { provider: "openai", modelId: model };
}, { chat: (model: string) => { constructors.chat(options, model); return { provider: "chat", modelId: model }; } }) }));

const root = mkdtempSync(join(tmpdir(), "talome-configured-model-"));
vi.stubEnv("DATABASE_PATH", join(root, "test.db"));
vi.stubEnv("TALOME_SECRET", "a".repeat(64));
const sqlite = new Database(process.env.DATABASE_PATH!);
sqlite.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const { setSetting } = await import("../utils/settings.js");
const { getConfiguredModel, resolveModel } = await import("../ai/configured-model.js");

beforeEach(() => {
  sqlite.exec("DELETE FROM settings");
  vi.clearAllMocks();
  for (const key of ["DEFAULT_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY"]) vi.stubEnv(key, "");
});
afterAll(() => { sqlite.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("shared configured model selection", () => {
  it("preserves OpenAI preferences and decrypts the stored key before constructing the model", () => {
    setSetting("ai_provider", "openai"); setSetting("ai_model", "gpt-user-choice"); setSetting("openai_key", "test-openai-secret");
    expect((sqlite.prepare("SELECT value FROM settings WHERE key = 'openai_key'").get() as {value: string}).value).not.toBe("test-openai-secret");
    expect(getConfiguredModel()).toMatchObject({ provider: "openai", modelId: "gpt-user-choice" });
    expect(constructors.openai).toHaveBeenCalledWith({ apiKey: "test-openai-secret" }, "gpt-user-choice");
    expect(constructors.anthropic).not.toHaveBeenCalled();
  });
  it("decrypts Anthropic keys and preserves a full saved model ID", () => {
    setSetting("ai_provider", "anthropic"); setSetting("ai_model", "claude-user-choice"); setSetting("anthropic_key", "test-anthropic-secret");
    getConfiguredModel();
    expect(constructors.anthropic).toHaveBeenCalledWith({ apiKey: "test-anthropic-secret" }, "claude-user-choice");
  });
  it("never silently switches providers when the selected provider lacks credentials", () => {
    setSetting("ai_provider", "openai"); setSetting("anthropic_key", "available-but-not-selected");
    expect(() => getConfiguredModel("legacy-anthropic-key")).toThrow("No OpenAI API key");
    expect(constructors.anthropic).not.toHaveBeenCalled();
  });
  it("keeps the existing environment fallback and model override", () => {
    setSetting("ai_provider", "openai"); setSetting("ai_model", "saved-model");
    vi.stubEnv("OPENAI_API_KEY", "environment-test-key"); vi.stubEnv("DEFAULT_MODEL", "environment-model");
    expect(getConfiguredModel().modelId).toBe("environment-model");
    expect(constructors.openai).toHaveBeenCalledWith({ apiKey: "environment-test-key" }, "environment-model");
  });
  it("keeps Kimi on Chat Completions and Ollama on its configured URL", () => {
    setSetting("ai_provider", "kimi"); setSetting("ai_model", "kimi-user-choice"); setSetting("kimi_key", "kimi-test");
    getConfiguredModel();
    expect(constructors.chat).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://api.moonshot.ai/v1" }), "kimi-user-choice");
    setSetting("ai_provider", "ollama"); setSetting("ai_model", "local-model"); setSetting("ollama_url", "http://127.0.0.1:11434/");
    getConfiguredModel();
    expect(constructors.openai).toHaveBeenCalledWith({ baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" }, "local-model");
  });
  it("preserves chat's existing Anthropic hint behavior", () => {
    setSetting("ai_model", "saved-model");
    expect(resolveModel("anthropic", "sonnet")).toBe("claude-sonnet-4-20250514");
    expect(resolveModel("openai", "explicit-model")).toBe("explicit-model");
  });
});
