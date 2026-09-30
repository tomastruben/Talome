import { Hono } from "hono";
import { getSetting } from "../utils/settings.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextWindow?: number;
}

export type AiProvider = "anthropic" | "openai" | "kimi" | "ollama";

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

// Kimi exposes an OpenAI-compatible Chat Completions API. Keep this catalog
// explicit so model selection still works before (and without) a network call.
const KIMI_MODELS: ModelInfo[] = [
  { id: "kimi-k3", name: "Kimi K3", description: "Flagship reasoning model · 1M context", contextWindow: 1_000_000 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", description: "Agentic coding model", contextWindow: 262_144 },
  { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed", description: "Faster agentic coding model", contextWindow: 262_144 },
  { id: "kimi-k2.6", name: "Kimi K2.6", description: "General-purpose reasoning model", contextWindow: 262_144 },
];

// ── Fetch OpenAI models from API ─────────────────────────────────────────────

// Only consider chat-capable models — exclude audio, realtime, transcribe, TTS,
// image, search, dated snapshots (YYYY-MM-DD suffix), and deep-research variants.
const OPENAI_CHAT_PREFIXES = ["gpt-", "o1", "o3", "o4", "codex"];
const OPENAI_EXCLUDE_PATTERNS = [
  /\d{4}-\d{2}-\d{2}/, // dated snapshot (e.g. gpt-4o-2024-08-06)
  /audio/,
  /image/,
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

const OPENAI_TIER_PATTERN = /^gpt-(\d+(?:\.\d+)?)-(sol|terra|luna)$/;
const OPENAI_TIER_ORDER = ["terra", "sol", "luna"] as const;
const OPENAI_TIER_DESCRIPTIONS: Record<(typeof OPENAI_TIER_ORDER)[number], string> = {
  terra: "Recommended · balanced for everyday work",
  sol: "Most capable · for complex work",
  luna: "Fastest · lowest cost",
};

interface OpenAiApiModel {
  id: string;
  created: number;
}

function compareModelGenerations(a: string, b: string): number {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  const length = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

function prettifyOpenAiName(id: string): string {
  return id
    .split("-")
    .map((part, i) => {
      if (i === 0 && part.startsWith("gpt")) return part.toUpperCase();
      if (["mini", "nano", "sol", "terra", "luna"].includes(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }
      return part;
    })
    .join("-")
    .replace(/-Mini/, " Mini")
    .replace(/-Nano/, " Nano")
    .replace(/-(Sol|Terra|Luna)$/, " $1");
}

/**
 * Keep the OpenAI picker focused on the latest current generation. The API
 * returns every model an account can access, including legacy and specialist
 * models that are not useful choices for Talome's general assistant.
 */
export function curateOpenAiModels(models: OpenAiApiModel[]): ModelInfo[] {
  const relevant = models
    .filter((model) => isRelevantOpenAiModel(model.id))
    .sort((a, b) => b.created - a.created);
  const tiered = relevant.flatMap((model) => {
    const match = OPENAI_TIER_PATTERN.exec(model.id);
    return match ? [{ model, generation: match[1], tier: match[2] }] : [];
  });

  const latestGeneration = tiered.reduce<string | undefined>((latest, candidate) => (
    !latest || compareModelGenerations(candidate.generation, latest) > 0
      ? candidate.generation
      : latest
  ), undefined);

  if (latestGeneration) {
    return tiered
      .filter((candidate) => candidate.generation === latestGeneration)
      .sort((a, b) => (
        OPENAI_TIER_ORDER.indexOf(a.tier as (typeof OPENAI_TIER_ORDER)[number])
        - OPENAI_TIER_ORDER.indexOf(b.tier as (typeof OPENAI_TIER_ORDER)[number])
      ))
      .map(({ model, tier }) => ({
        id: model.id,
        name: prettifyOpenAiName(model.id),
        description: OPENAI_TIER_DESCRIPTIONS[tier as (typeof OPENAI_TIER_ORDER)[number]],
      }));
  }

  // Older or partially provisioned accounts may not expose the tiered family.
  // Keep one newest relevant chat model so model selection never becomes empty.
  return relevant.slice(0, 1).map((model) => ({
    id: model.id,
    name: prettifyOpenAiName(model.id),
    description: "Latest available chat model",
  }));
}

export function resolveOpenAiActiveModel(activeModel: string, models: ModelInfo[]): string {
  if (models.length === 0 || models.some((model) => model.id === activeModel)) {
    return activeModel;
  }

  return models[0].id;
}

async function fetchOpenAiModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data: Array<{ id: string; created: number }> };
    return curateOpenAiModels(data.data || []);
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
  const kimiKey = getSetting("kimi_key") || process.env.MOONSHOT_API_KEY;
  const ollamaUrl = getSetting("ollama_url");

  const anthropicConfigured = !!anthropicKey;
  const openaiConfigured = !!openaiKey;
  const kimiConfigured = !!kimiKey;
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
    { provider: "kimi", configured: kimiConfigured, models: KIMI_MODELS },
    { provider: "ollama", configured: ollamaReady, models: ollamaModels },
  ];

  const visibleActiveModel = activeProvider === "openai"
    ? resolveOpenAiActiveModel(activeModel, openaiModels)
    : activeModel;
  const response: AiModelsResponse = {
    activeProvider,
    activeModel: visibleActiveModel,
    providers,
  };
  return c.json(response);
});

/** POST /api/ai/test — validate that the active provider is reachable */
aiModels.post("/test", async (c) => {
  // Test a provider before switching to it (Settings › AI): the body may name
  // one; otherwise the active provider is tested.
  const body = (await c.req.json().catch(() => null)) as { provider?: unknown } | null;
  const requested = typeof body?.provider === "string" ? body.provider : undefined;
  if (requested !== undefined && !["anthropic", "openai", "kimi", "ollama"].includes(requested)) {
    return c.json({ ok: false, error: "Unknown provider" }, 400);
  }
  const activeProvider = (requested || getSetting("ai_provider") || "anthropic") as AiProvider;
  const anthropicKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
  const openaiKey = getSetting("openai_key") || process.env.OPENAI_API_KEY;
  const kimiKey = getSetting("kimi_key") || process.env.MOONSHOT_API_KEY;
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

      case "kimi": {
        if (!kimiKey) return c.json({ ok: false, error: "No Kimi API key configured" });
        const res = await fetch("https://api.moonshot.ai/v1/models", {
          headers: { Authorization: `Bearer ${kimiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
          return c.json({ ok: false, error: data.error?.message || `HTTP ${res.status}` });
        }
        return c.json({ ok: true, provider: "kimi" });
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
    case "kimi":
      return "kimi-k3";
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
