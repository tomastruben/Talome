import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getSetting } from "../utils/settings.js";

export type ConfiguredAiProvider = "anthropic" | "openai" | "kimi" | "ollama";

// Existing chat defaults; explicit saved model IDs and DEFAULT_MODEL still win.
const DEFAULT_MODELS: Record<ConfiguredAiProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001", openai: "gpt-4o-mini", kimi: "kimi-k3", ollama: "",
};
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-20250514",
};

export function getActiveProvider(): ConfiguredAiProvider {
  const stored = getSetting("ai_provider");
  return stored === "anthropic" || stored === "openai" || stored === "kimi" || stored === "ollama" ? stored : "anthropic";
}

export function resolveModel(provider: ConfiguredAiProvider, hint?: string): string {
  if (process.env.DEFAULT_MODEL) return process.env.DEFAULT_MODEL;
  if (provider === "anthropic" && hint && ANTHROPIC_MODEL_MAP[hint]) return ANTHROPIC_MODEL_MAP[hint];
  if (hint?.includes("-")) return hint;
  return getSetting("ai_model") || DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
}

export function createModelInstance(provider: ConfiguredAiProvider, modelId: string, legacyAnthropicKey?: string): LanguageModel {
  const missing = (name: string) => new Error(`AI_PROVIDER_NOT_CONFIGURED: No ${name} configured. Add it in Settings → AI Provider.`);
  switch (provider) {
    case "anthropic": {
      const apiKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY || legacyAnthropicKey;
      if (!apiKey) throw missing("Anthropic API key");
      return createAnthropic({ apiKey })(modelId);
    }
    case "openai": {
      const apiKey = getSetting("openai_key") || process.env.OPENAI_API_KEY;
      if (!apiKey) throw missing("OpenAI API key");
      return createOpenAI({ apiKey })(modelId);
    }
    case "kimi": {
      const apiKey = getSetting("kimi_key") || process.env.MOONSHOT_API_KEY;
      if (!apiKey) throw missing("Kimi API key");
      return createOpenAI({ name: "moonshotai", baseURL: "https://api.moonshot.ai/v1", apiKey }).chat(modelId);
    }
    case "ollama": {
      const url = getSetting("ollama_url");
      if (!url) throw missing("Ollama server URL");
      return createOpenAI({ baseURL: `${url.replace(/\/$/, "")}/v1`, apiKey: "ollama" })(modelId);
    }
  }
}

/** The same selection and secret-aware credential lookup used by chat and creation. */
export function getConfiguredModel(legacyAnthropicKey?: string) {
  const provider = getActiveProvider();
  const modelId = resolveModel(provider);
  return { provider, modelId, model: createModelInstance(provider, modelId, legacyAnthropicKey) };
}
