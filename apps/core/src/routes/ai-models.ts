import { Hono } from "hono";
import { getSetting } from "../utils/settings.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow?: number;
}

export type AiProvider = "anthropic" | "openai" | "ollama";

export interface ProviderModels {
  provider: AiProvider;
  configured: boolean;
  models: ModelInfo[];
}

export interface AiModelsResponse {
  activeProvider: AiProvider;
  activeModel: string;
  providers: ProviderModels[];
}

// ── Static Anthropic catalog ─────────────────────────────────────────────────

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-haiku-4-5-20251001", name: "Haiku", description: "Fast and affordable", contextWindow: 200_000 },
  { id: "claude-sonnet-4-20250514", name: "Sonnet", description: "Balanced performance", contextWindow: 200_000 },
];

// ── Fetch OpenAI models from API ─────────────────────────────────────────────

// Only show chat-capable models — exclude audio, realtime, transcribe, TTS,
// search, dated snapshots (YYYY-MM-DD suffix), and deep-research variants.
const OPENAI_CHAT_PREFIXES = ["gpt-", "o1", "o3", "o4", "codex"];
const OPENAI_EXCLUDE_PATTERNS = [
  /\d{4}-\d{2}-\d{2}/, // dated snapshot (e.g. gpt-4o-2024-08-06)
  /audio/,
  /realtime/,
  /transcribe/,
  /tts/,
  /search/,
  /deep-research/,
  /pro$/,                // o1-pro, o3-pro — very expensive, unlikely useful
];

function isRelevantOpenAiModel(id: string): boolean {
  if (!OPENAI_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix))) return false;
  if (OPENAI_EXCLUDE_PATTERNS.some((rx) => rx.test(id))) return false;
  return true;
}

function prettifyOpenAiName(id: string): string {
  return id
    .split("-")
    .map((part, i) => {
      if (i === 0 && part.startsWith("gpt")) return part.toUpperCase();
      if (part === "mini" || part === "nano") return part.charAt(0).toUpperCase() + part.slice(1);
      return part;
    })
    .join("-")
    .replace(/-Mini/, " Mini")
    .replace(/-Nano/, " Nano");
}

async function fetchOpenAiModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data: Array<{ id: string; created: number }> };
    return (data.data || [])
      .filter((m) => isRelevantOpenAiModel(m.id))
      .sort((a, b) => b.created - a.created)
      .map((m) => ({
        id: m.id,
        name: prettifyOpenAiName(m.id),
        description: "",
      }));
  } catch {
    return [];
  }
}

// ── Route ────────────────────────────────────────────────────────────────────

const aiModels = new Hono();

/** GET /api/ai/models — available models grouped by provider + active selection */
aiModels.get("/models", async (c) => {
  const activeProvider = (getSetting("ai_provider") || "anthropic") as AiProvider;
  const activeModel = getSetting("ai_model") || getDefaultModel(activeProvider);

  const anthropicKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
  const openaiKey = getSetting("openai_key") || process.env.OPENAI_API_KEY;
  const ollamaUrl = getSetting("ollama_url");

  const anthropicConfigured = !!anthropicKey;
  const openaiConfigured = !!openaiKey;
  const ollamaConfigured = !!ollamaUrl;

  // Fetch OpenAI and Ollama models in parallel
  const [openaiModels, ollamaModels] = await Promise.all([
    openaiConfigured && openaiKey ? fetchOpenAiModels(openaiKey) : Promise.resolve([]),
    ollamaConfigured && ollamaUrl ? fetchOllamaModels(ollamaUrl) : Promise.resolve([]),
  ]);

  // Ollama is only "configured" if the URL is set AND at least one model is available
  const ollamaReady = ollamaConfigured && ollamaModels.length > 0;

  const providers: ProviderModels[] = [
    { provider: "anthropic", configured: anthropicConfigured, models: ANTHROPIC_MODELS },
    { provider: "openai", configured: openaiConfigured, models: openaiModels },
    { provider: "ollama", configured: ollamaReady, models: ollamaModels },
  ];

  const response: AiModelsResponse = { activeProvider, activeModel, providers };
  return c.json(response);
});

/** POST /api/ai/test — validate that the active provider is reachable */
aiModels.post("/test", async (c) => {
  const activeProvider = (getSetting("ai_provider") || "anthropic") as AiProvider;
  const anthropicKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
  const openaiKey = getSetting("openai_key") || process.env.OPENAI_API_KEY;
  const ollamaUrl = getSetting("ollama_url");

  try {
    switch (activeProvider) {
      case "anthropic": {
        if (!anthropicKey) return c.json({ ok: false, error: "No API key configured" });
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
          return c.json({ ok: false, error: data.error?.message || `HTTP ${res.status}` });
        }
        return c.json({ ok: true, provider: "anthropic" });
      }

      case "openai": {
        if (!openaiKey) return c.json({ ok: false, error: "No API key configured" });
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${openaiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return c.json({ ok: false, error: `HTTP ${res.status}` });
        return c.json({ ok: true, provider: "openai" });
      }

      case "ollama": {
        if (!ollamaUrl) return c.json({ ok: false, error: "No Ollama URL configured" });
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return c.json({ ok: false, error: `Ollama returned HTTP ${res.status}` });
        const data = await res.json() as { models?: unknown[] };
        const count = data.models?.length ?? 0;
        if (count === 0) return c.json({ ok: false, error: "Ollama is running but has no models. Pull one first." });
        return c.json({ ok: true, provider: "ollama", models: count });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    return c.json({ ok: false, error: msg });
  }
});

// ── Ollama model fetch ───────────────────────────────────────────────────────

async function fetchOllamaModels(url: string): Promise<ModelInfo[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models: Array<{
        name: string;
        size: number;
        details?: { parameter_size?: string; family?: string };
      }>;
    };
    return (data.models || []).map((m) => ({
      id: m.name,
      name: m.name.split(":")[0],
      description: [m.details?.parameter_size, m.details?.family, formatBytes(m.size)]
        .filter(Boolean)
        .join(" · "),
    }));
  } catch {
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultModel(provider: AiProvider): string {
  switch (provider) {
    case "anthropic":
      return "claude-haiku-4-5-20251001";
    case "openai":
      return "gpt-4o-mini";
    case "ollama":
      return "";
    default:
      return "claude-haiku-4-5-20251001";
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

export { aiModels };
