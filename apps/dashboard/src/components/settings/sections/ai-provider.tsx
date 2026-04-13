"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon, Delete01Icon, LinkSquare01Icon, CheckmarkCircle02Icon, AlertCircleIcon, ArrowRight01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, SecretRow, TextRow } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

/* ── Types ───────────────────────────────────────────────────────────────── */

type AiProvider = "anthropic" | "openai" | "ollama";

interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

interface ProviderModels {
  provider: AiProvider;
  configured: boolean;
  models: ModelInfo[];
}

interface AiModelsResponse {
  activeProvider: AiProvider;
  activeModel: string;
  providers: ProviderModels[];
}

interface OllamaModel {
  name: string;
  size: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const PROVIDER_META: Record<AiProvider, { label: string; hint: string; badge?: string }> = {
  anthropic: { label: "Anthropic", hint: "Claude models", badge: "Recommended" },
  openai: { label: "OpenAI", hint: "GPT models" },
  ollama: { label: "Ollama", hint: "Local models" },
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/* ── Provider card ────────────────────────────────────────────────────────── */

function ProviderCard({
  provider,
  configured,
  isActive,
  onClick,
}: {
  provider: AiProvider;
  configured: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  const meta = PROVIDER_META[provider];

  // Three states: active, configured (ready), unconfigured
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative rounded-xl border p-4 text-left transition-all duration-150 ${
        isActive
          ? "border-foreground/25 bg-foreground/[0.05] ring-1 ring-foreground/10"
          : configured
            ? "border-border/50 hover:border-foreground/20 hover:bg-foreground/[0.02]"
            : "border-border/30 opacity-70 hover:opacity-100 hover:border-border/50"
      }`}
    >
      <div className="flex items-center gap-2">
        <p className={`text-sm font-medium ${isActive ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>
          {meta.label}
        </p>

        {/* Status indicator: single source of truth */}
        {isActive ? (
          <span className="flex items-center gap-1 rounded-full bg-status-healthy/15 text-status-healthy px-1.5 py-0.5 text-[10px] font-medium">
            <span className="size-1 rounded-full bg-current" />
            Active
          </span>
        ) : configured ? (
          <span className="flex items-center gap-1 rounded-full bg-foreground/5 text-muted-foreground px-1.5 py-0.5 text-[10px] font-medium">
            <span className="size-1 rounded-full bg-status-healthy" />
            Ready
          </span>
        ) : meta.badge ? (
          <span className="rounded-full bg-foreground/5 text-muted-foreground px-1.5 py-0.5 text-[10px] font-medium">{meta.badge}</span>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground mt-1">{meta.hint}</p>

      {/* Subtle arrow for non-active cards */}
      {!isActive && configured && (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={12}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all duration-150"
        />
      )}
    </button>
  );
}

/* ── Main section ─────────────────────────────────────────────────────────── */

export function AiProviderSection() {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicEditing, setAnthropicEditing] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiEditing, setOpenaiEditing] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [saving, setSaving] = useState(false);

  // Active model selection
  const [activeProvider, setActiveProvider] = useState<AiProvider>("anthropic");
  const [activeModel, setActiveModel] = useState("");
  const [savingModel, setSavingModel] = useState(false);

  // Fetch available models from API
  const { data: modelsData, mutate: mutateModels } = useSWR<AiModelsResponse>(
    `${CORE_URL}/api/ai/models`,
    fetcher,
    { revalidateOnFocus: false },
  );

  // Ollama models (for pull/delete management)
  const { data: ollamaData, mutate: mutateOllamaModels } = useSWR<{ models: OllamaModel[] }>(
    ollamaUrl ? `${CORE_URL}/api/ollama/models` : null,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false },
  );
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState(false);
  const ollamaModels = ollamaData?.models ?? [];

  // Sync from server state
  useEffect(() => {
    if (modelsData) {
      setActiveProvider(modelsData.activeProvider);
      setActiveModel(modelsData.activeModel);
    }
  }, [modelsData]);

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.anthropic_key) setAnthropicKey(data.anthropic_key);
        if (data.openai_key) setOpenaiKey(data.openai_key);
        if (data.ollama_url) setOllamaUrl(data.ollama_url);
      })
      .catch(() => {});
  }, []);

  // Get models for the selected provider
  const providerData = modelsData?.providers.find((p) => p.provider === activeProvider);
  const availableModels = providerData?.models ?? [];
  const isConfigured = providerData?.configured ?? false;

  const saveKeys = async (providerScope?: AiProvider) => {
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (!providerScope || providerScope === "anthropic") {
        if (anthropicEditing || !anthropicKey) body.anthropic_key = anthropicKey;
      }
      if (!providerScope || providerScope === "openai") {
        if (openaiEditing || !openaiKey) body.openai_key = openaiKey;
      }
      if (!providerScope || providerScope === "ollama") {
        body.ollama_url = ollamaUrl;
      }
      if (Object.keys(body).length === 0) {
        setSaving(false);
        return;
      }
      await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (providerScope === "anthropic" || !providerScope) setAnthropicEditing(false);
      if (providerScope === "openai" || !providerScope) setOpenaiEditing(false);
      toast.success("Saved");
      mutateModels();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const saveModelSelection = useCallback(async (provider: AiProvider, model: string) => {
    setSavingModel(true);
    try {
      await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai_provider: provider, ai_model: model }),
      });
      toast.success(`Switched to ${PROVIDER_META[provider].label}`);
      mutateModels();
    } catch {
      toast.error("Failed to save model selection");
    } finally {
      setSavingModel(false);
    }
  }, [mutateModels]);

  const handleProviderChange = useCallback((provider: AiProvider) => {
    setActiveProvider(provider);
    const models = modelsData?.providers.find((p) => p.provider === provider)?.models ?? [];
    const firstModel = models[0]?.id ?? "";
    setActiveModel(firstModel);
    saveModelSelection(provider, firstModel);
  }, [modelsData, saveModelSelection]);

  const handleModelChange = useCallback((model: string) => {
    setActiveModel(model);
    saveModelSelection(activeProvider, model);
  }, [activeProvider, saveModelSelection]);

  async function pullModel() {
    if (!pullName.trim()) return;
    setPulling(true);
    try {
      const res = await fetch(`${CORE_URL}/api/ollama/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pullName.trim() }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      toast.success(`Pulled ${pullName.trim()}`);
      setPullName("");
      mutateOllamaModels();
      mutateModels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Pull failed");
    } finally {
      setPulling(false);
    }
  }

  async function removeModel(name: string) {
    try {
      await fetch(`${CORE_URL}/api/ollama/models/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast.success(`Removed ${name}`);
      mutateOllamaModels();
      mutateModels();
    } catch {
      toast.error("Failed to remove model");
    }
  }

  // ── Test connection ─────────────────────────────────────────────────────
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // Reset test result when provider changes
  useEffect(() => {
    setTestResult(null);
  }, [activeProvider]);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${CORE_URL}/api/ai/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data as { ok: boolean; error?: string });
    } catch {
      setTestResult({ ok: false, error: "Could not reach the server" });
    } finally {
      setTesting(false);
    }
  };

  // Helper: which providers are configured
  const getConfigured = (p: AiProvider) =>
    modelsData?.providers.find((pd) => pd.provider === p)?.configured ?? false;

  return (
    <div className="grid gap-8">

      {/* ── Step 1: Choose provider ────────────────────────── */}
      <section className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Choose an AI provider. You can configure multiple and switch anytime.
        </p>

        <div className="grid sm:grid-cols-3 gap-3">
          {(["anthropic", "openai", "ollama"] as const).map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              configured={getConfigured(p)}
              isActive={activeProvider === p}
              onClick={() => handleProviderChange(p)}
            />
          ))}
        </div>
      </section>

      {/* ── Step 2: Configure the active provider ─────────── */}
      <section className="grid gap-3">
        {activeProvider === "anthropic" && (
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <div className="flex items-center gap-2 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Anthropic</p>
                {getConfigured("anthropic") && (
                  <span className="flex items-center gap-1 text-[10px] text-status-healthy font-medium">
                    <HugeiconsIcon icon={CheckmarkCircle02Icon} size={10} />
                    Connected
                  </span>
                )}
              </div>
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
                Get key
              </a>
            </SettingsRow>
            <SecretRow
              label="API Key" hint="Required for Claude models"
              id="anthropic-key" placeholder="sk-ant-..."
              storedValue={anthropicKey} isEditing={anthropicEditing}
              onEdit={() => { setAnthropicEditing(true); setAnthropicKey(""); }}
              onChange={setAnthropicKey}
            />
            <SettingsRow className="bg-muted/30 justify-end py-3">
              <Button size="sm" onClick={() => saveKeys("anthropic")} disabled={saving} className="h-7 text-xs px-4">
                {saving ? "Saving..." : "Save"}
              </Button>
            </SettingsRow>
          </SettingsGroup>
        )}

        {activeProvider === "openai" && (
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <div className="flex items-center gap-2 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">OpenAI</p>
                {getConfigured("openai") && (
                  <span className="flex items-center gap-1 text-[10px] text-status-healthy font-medium">
                    <HugeiconsIcon icon={CheckmarkCircle02Icon} size={10} />
                    Connected
                  </span>
                )}
              </div>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
                Get key
              </a>
            </SettingsRow>
            <SecretRow
              label="API Key" hint="Required for GPT models"
              id="openai-key" placeholder="sk-..."
              storedValue={openaiKey} isEditing={openaiEditing}
              onEdit={() => { setOpenaiEditing(true); setOpenaiKey(""); }}
              onChange={setOpenaiKey}
            />
            <SettingsRow className="bg-muted/30 justify-end py-3">
              <Button size="sm" onClick={() => saveKeys("openai")} disabled={saving} className="h-7 text-xs px-4">
                {saving ? "Saving..." : "Save"}
              </Button>
            </SettingsRow>
          </SettingsGroup>
        )}

        {activeProvider === "ollama" && (
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <div className="flex items-center gap-2 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ollama</p>
                {getConfigured("ollama") && (
                  <span className="flex items-center gap-1 text-[10px] text-status-healthy font-medium">
                    <HugeiconsIcon icon={CheckmarkCircle02Icon} size={10} />
                    Connected
                  </span>
                )}
                {ollamaModels.length > 0 && (
                  <span className="text-[10px] text-muted-foreground font-medium tabular-nums">
                    {ollamaModels.length} model{ollamaModels.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <a
                href="https://ollama.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
                ollama.com
              </a>
            </SettingsRow>

            <TextRow
              label="Server URL" hint="Ollama must be running at this address"
              id="ollama-url" placeholder="http://localhost:11434"
              value={ollamaUrl} onChange={setOllamaUrl}
            />

            {ollamaModels.map((m) => (
              <SettingsRow key={m.name}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium font-mono truncate">{m.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatSize(m.size)}
                    {m.details?.parameter_size && ` · ${m.details.parameter_size}`}
                    {m.details?.quantization_level && ` · ${m.details.quantization_level}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => removeModel(m.name)}
                >
                  <HugeiconsIcon icon={Delete01Icon} size={14} />
                </Button>
              </SettingsRow>
            ))}

            <SettingsRow className="gap-2">
              <Input
                placeholder="Pull a model — e.g. llama3.2, mistral, gemma2"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void pullModel(); }}
                className="h-8 text-sm flex-1 font-mono"
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-8 text-xs px-3 shrink-0"
                disabled={pulling || !pullName.trim()}
                onClick={() => void pullModel()}
              >
                {pulling ? "Pulling..." : "Pull"}
              </Button>
            </SettingsRow>

            <SettingsRow className="bg-muted/30 justify-end py-3">
              <Button size="sm" onClick={() => saveKeys("ollama")} disabled={saving} className="h-7 text-xs px-4">
                {saving ? "Saving..." : "Save"}
              </Button>
            </SettingsRow>
          </SettingsGroup>
        )}
      </section>

      {/* ── Step 3: Model selection (only when configured) ── */}
      {isConfigured && availableModels.length > 0 && (
        <section className="grid gap-3">
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Model</p>
            </SettingsRow>
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {PROVIDER_META[activeProvider].label} model
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {activeProvider === "ollama" ? "Locally installed models" : "Choose which model powers the assistant"}
                </p>
              </div>
              <Select
                value={activeModel}
                onValueChange={handleModelChange}
                disabled={savingModel}
              >
                <SelectTrigger className="w-full sm:w-72 h-8 text-xs">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      <span className="font-medium">{m.name}</span>
                      {m.description && (
                        <span className="text-muted-foreground ml-2">{m.description}</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </SettingsGroup>
        </section>
      )}

      {/* ── Not configured hint ────────────────────────────── */}
      {!isConfigured && (
        <p className="text-xs text-status-warning px-1">
          {activeProvider === "ollama"
            ? "Add the Ollama server URL above and pull a model to get started."
            : `Add your ${PROVIDER_META[activeProvider].label} API key above to get started.`}
        </p>
      )}

      {/* ── Test connection ────────────────────────────────── */}
      {isConfigured && (
        <div className="flex items-center gap-3 px-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs px-3 shrink-0 gap-1.5"
            onClick={testConnection}
            disabled={testing}
          >
            {testing ? "Testing..." : testResult?.ok ? (
              <>
                <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} className="text-status-healthy" />
                Connected
              </>
            ) : testResult && !testResult.ok ? (
              <>
                <HugeiconsIcon icon={AlertCircleIcon} size={12} className="text-destructive" />
                Failed
              </>
            ) : "Test connection"}
          </Button>
          {testResult && !testResult.ok && (
            <p className="text-xs text-destructive/70 truncate">{testResult.error}</p>
          )}
        </div>
      )}

      <ConfigureWithAI prompt="I'd like to review my AI provider configuration" />
    </div>
  );
}
