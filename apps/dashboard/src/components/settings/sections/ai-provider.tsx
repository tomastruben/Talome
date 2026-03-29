"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon, Delete01Icon, LinkSquare01Icon, Tick01Icon, CheckmarkCircle02Icon, AlertCircleIcon } from "@/components/icons";
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

const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama",
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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

  const saveKeys = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = { ollama_url: ollamaUrl };
      if (anthropicEditing || !anthropicKey) body.anthropic_key = anthropicKey;
      if (openaiEditing || !openaiKey) body.openai_key = openaiKey;
      await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setAnthropicEditing(false);
      setOpenaiEditing(false);
      toast.success("Saved");
      // Refresh models after saving keys (provider configured state may change)
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
      toast.success(`Active model: ${PROVIDER_LABELS[provider]} / ${model || "(default)"}`);
      mutateModels();
    } catch {
      toast.error("Failed to save model selection");
    } finally {
      setSavingModel(false);
    }
  }, [mutateModels]);

  const handleProviderChange = useCallback((provider: AiProvider) => {
    setActiveProvider(provider);
    // Pick the first available model for this provider
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

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        The assistant needs at least one AI provider. Pick the one that fits your setup.
      </p>

      {/* ── Provider recommendation ──────────────────────── */}
      <div className="grid sm:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => handleProviderChange("anthropic")}
          className={`rounded-xl border p-4 text-left transition-all duration-150 ${
            activeProvider === "anthropic"
              ? "border-foreground/20 bg-foreground/[0.04]"
              : "border-border/40 hover:border-border/60"
          }`}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <p className="text-sm font-medium">Anthropic</p>
            <span className="rounded-full bg-status-healthy/15 text-status-healthy px-1.5 py-0.5 text-[10px] font-medium">Recommended</span>
          </div>
          <p className="text-xs text-muted-foreground">Best quality. Pay-per-use API key. Claude models.</p>
        </button>
        <button
          type="button"
          onClick={() => handleProviderChange("openai")}
          className={`rounded-xl border p-4 text-left transition-all duration-150 ${
            activeProvider === "openai"
              ? "border-foreground/20 bg-foreground/[0.04]"
              : "border-border/40 hover:border-border/60"
          }`}
        >
          <p className="text-sm font-medium mb-1.5">OpenAI</p>
          <p className="text-xs text-muted-foreground">GPT models. Pay-per-use API key. Alternative option.</p>
        </button>
        <button
          type="button"
          onClick={() => handleProviderChange("ollama")}
          className={`rounded-xl border p-4 text-left transition-all duration-150 ${
            activeProvider === "ollama"
              ? "border-foreground/20 bg-foreground/[0.04]"
              : "border-border/40 hover:border-border/60"
          }`}
        >
          <p className="text-sm font-medium mb-1.5">Ollama</p>
          <p className="text-xs text-muted-foreground">Free and private. Runs on your hardware. Requires setup.</p>
        </button>
      </div>

      {/* ── Active model selection ──────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active Model</p>
        </SettingsRow>

        <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Provider</p>
            <p className="text-xs text-muted-foreground mt-0.5">Which AI service to use for the assistant</p>
          </div>
          <div className="flex gap-1 p-0.5 rounded-lg bg-muted/50 shrink-0">
            {(["anthropic", "openai", "ollama"] as const).map((p) => {
              const pData = modelsData?.providers.find((pd) => pd.provider === p);
              const configured = pData?.configured ?? false;
              const isActive = activeProvider === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleProviderChange(p)}
                  disabled={savingModel}
                  className={`relative px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150 ${
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : configured
                        ? "text-muted-foreground hover:text-foreground"
                        : "text-dim-foreground hover:text-muted-foreground"
                  }`}
                >
                  {PROVIDER_LABELS[p]}
                  {configured && !isActive && (
                    <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-status-healthy" />
                  )}
                </button>
              );
            })}
          </div>
        </SettingsRow>

        {!isConfigured && (
          <SettingsRow>
            <p className="text-xs text-status-warning">
              {activeProvider === "ollama"
                ? "Ollama URL not configured — add it below and pull a model."
                : `No ${PROVIDER_LABELS[activeProvider]} API key configured — add it below.`}
            </p>
          </SettingsRow>
        )}

        <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Model</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {activeProvider === "ollama" ? "Locally installed models" : "Available models from this provider"}
            </p>
          </div>
          <Select
            value={activeModel}
            onValueChange={handleModelChange}
            disabled={savingModel || availableModels.length === 0}
          >
            <SelectTrigger className="w-full sm:w-72 h-8 text-xs">
              <SelectValue placeholder={availableModels.length === 0 ? "No models available" : "Select a model"} />
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

      {/* ── Cloud providers ─────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Anthropic</p>
          {activeProvider === "anthropic" && (
            <Badge variant="secondary" className="ml-2 text-xs gap-1">
              <HugeiconsIcon icon={Tick01Icon} size={10} />
              Active
            </Badge>
          )}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
            Get key
          </a>
        </SettingsRow>
        <SecretRow
          label="API Key" hint="Claude models — recommended"
          id="anthropic-key" placeholder="sk-ant-..."
          storedValue={anthropicKey} isEditing={anthropicEditing}
          onEdit={() => { setAnthropicEditing(true); setAnthropicKey(""); }}
          onChange={setAnthropicKey}
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">OpenAI</p>
          {activeProvider === "openai" && (
            <Badge variant="secondary" className="ml-2 text-xs gap-1">
              <HugeiconsIcon icon={Tick01Icon} size={10} />
              Active
            </Badge>
          )}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
            Get key
          </a>
        </SettingsRow>
        <SecretRow
          label="API Key" hint="GPT models — alternative"
          id="openai-key" placeholder="sk-..."
          storedValue={openaiKey} isEditing={openaiEditing}
          onEdit={() => { setOpenaiEditing(true); setOpenaiKey(""); }}
          onChange={setOpenaiKey}
        />

        <SettingsRow className="bg-muted/30 justify-end py-3">
          <Button size="sm" onClick={saveKeys} disabled={saving} className="h-7 text-xs px-4">
            {saving ? "Saving..." : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <div className="flex items-center gap-3 px-1">
        <p className="text-xs text-muted-foreground flex-1">
          Cloud providers charge per token. Create an account, generate an API key, and paste it above.
        </p>
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
      </div>
      {testResult && !testResult.ok && (
        <p className="text-xs text-destructive/70 px-1">{testResult.error}</p>
      )}

      {/* ── Ollama ──────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ollama</p>
          {activeProvider === "ollama" && (
            <Badge variant="secondary" className="ml-2 text-xs gap-1">
              <HugeiconsIcon icon={Tick01Icon} size={10} />
              Active
            </Badge>
          )}
          {ollamaModels.length > 0 && (
            <Badge variant="secondary" className="ml-2 text-xs tabular-nums">
              {ollamaModels.length} model{ollamaModels.length !== 1 ? "s" : ""}
            </Badge>
          )}
          <a
            href="https://ollama.com"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
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
          <Button size="sm" onClick={saveKeys} disabled={saving} className="h-7 text-xs px-4">
            {saving ? "Saving..." : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <p className="text-xs text-muted-foreground px-1">
        Ollama runs open-source models locally — free, private, no account needed. Install it, start the server, and pull a model above.
      </p>

      <ConfigureWithAI prompt="I'd like to review my AI provider configuration" />
    </div>
  );
}
