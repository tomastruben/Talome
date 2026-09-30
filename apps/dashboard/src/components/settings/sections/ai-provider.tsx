"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { HugeiconsIcon, Delete01Icon, LinkSquare01Icon, CheckmarkCircle02Icon, AlertCircleIcon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, SecretRow, TextRow, settingsFetcher, settingsRequest } from "@/components/settings/settings-primitives";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatBytes } from "@/lib/format";
import { VoiceSettings } from "@/components/settings/voice-settings";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

/* ── Types ───────────────────────────────────────────────────────────────── */

type AiProvider = "anthropic" | "openai" | "kimi" | "ollama";

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
  kimi: { label: "Kimi", hint: "Kimi K3 models" },
  ollama: { label: "Ollama", hint: "Local models" },
};

const fetcher = settingsFetcher;

/** Provider-aware wording for a failed test: what failed and the fix. */
export function describeTestFailure(provider: AiProvider, error?: string): string {
  const label = PROVIDER_META[provider].label;
  const detail = error?.trim();
  if (!detail) return `Couldn't reach ${label}. Check the settings above, then test again.`;
  if (/no (api key|.*key) configured/i.test(detail)) {
    return `Add ${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} API key above, then test again.`;
  }
  if (/no ollama url/i.test(detail)) return "Add the Ollama server URL above, then test again.";
  if (/HTTP 401|HTTP 403|invalid.*key|authentication/i.test(detail)) {
    return `${label} rejected the API key. Paste a new key above, then test again.`;
  }
  return `${label}: ${detail}`;
}

/* ── Provider card ────────────────────────────────────────────────────────── */

function ProviderCard({
  provider,
  configured,
  isActive,
  isSelected,
  onClick,
}: {
  provider: AiProvider;
  configured: boolean;
  /** The provider the Assistant uses now (server state). */
  isActive: boolean;
  /** The provider whose settings are shown below. Selecting never switches. */
  isSelected: boolean;
  onClick: () => void;
}) {
  const meta = PROVIDER_META[provider];

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      className={`group relative rounded-xl border p-4 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        isSelected
          ? "border-foreground/60 bg-muted/40"
          : "border-border hover:bg-muted/30"
      }`}
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-foreground">
          {meta.label}
        </p>

        {/* Status indicator: single source of truth */}
        {isActive ? (
          <span className="flex items-center gap-1 rounded-full bg-status-healthy/12 text-status-healthy px-1.5 py-0.5 text-xs font-medium">
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            In use
          </span>
        ) : configured ? (
          <span className="rounded-full bg-muted text-muted-foreground px-1.5 py-0.5 text-xs font-medium">
            Set up
          </span>
        ) : meta.badge ? (
          <span className="rounded-full bg-muted text-muted-foreground px-1.5 py-0.5 text-xs font-medium">{meta.badge}</span>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground mt-1">{meta.hint}</p>

    </button>
  );
}

/* ── Main section ─────────────────────────────────────────────────────────── */

export function AiProviderSection() {
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicEditing, setAnthropicEditing] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiEditing, setOpenaiEditing] = useState(false);
  const [kimiKey, setKimiKey] = useState("");
  const [kimiEditing, setKimiEditing] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [saving, setSaving] = useState(false);

  // `selectedProvider` is the card being looked at; the server's
  // activeProvider only changes through "Use {provider}" after a passing test.
  const [selectedProvider, setSelectedProvider] = useState<AiProvider | null>(null);
  const [stagedModel, setStagedModel] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const confirm = useConfirm();

  // Fetch available models from API
  const { data: modelsData, error: modelsError, mutate: mutateModels } = useSWR<AiModelsResponse>(
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

  const serverProvider = modelsData?.activeProvider;
  const activeProvider: AiProvider = selectedProvider ?? serverProvider ?? "anthropic";
  const isServerActive = activeProvider === serverProvider;
  const activeModel = isServerActive && !stagedModel ? (modelsData?.activeModel ?? "") : stagedModel;
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadStoredSettings = useCallback(() => {
    setSettingsError(null);
    settingsFetcher<Record<string, string>>(`${CORE_URL}/api/settings`)
      .then((data) => {
        if (data.anthropic_key) setAnthropicKey(data.anthropic_key);
        if (data.openai_key) setOpenaiKey(data.openai_key);
        if (data.kimi_key) setKimiKey(data.kimi_key);
        if (data.ollama_url) setOllamaUrl(data.ollama_url);
      })
      .catch((err: unknown) => setSettingsError(err instanceof Error ? err.message : "Couldn't load the saved keys."));
  }, []);

  useEffect(() => {
    loadStoredSettings();
  }, [loadStoredSettings]);

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
      if (!providerScope || providerScope === "kimi") {
        if (kimiEditing || !kimiKey) body.kimi_key = kimiKey;
      }
      if (!providerScope || providerScope === "ollama") {
        body.ollama_url = ollamaUrl;
      }
      if (Object.keys(body).length === 0) {
        setSaving(false);
        return;
      }
      await settingsRequest(`${CORE_URL}/api/settings`, { method: "POST", body }, "Couldn't save. Check the value, then try again.");
      if (providerScope === "anthropic" || !providerScope) setAnthropicEditing(false);
      if (providerScope === "openai" || !providerScope) setOpenaiEditing(false);
      if (providerScope === "kimi" || !providerScope) setKimiEditing(false);
      setLastTest(null);
      toast.success(providerScope ? `Saved ${PROVIDER_META[providerScope].label} settings. Test them next.` : "Saved");
      await mutateModels();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const saveModelSelection = useCallback(async (provider: AiProvider, model: string, message: string) => {
    setSavingModel(true);
    try {
      await settingsRequest(
        `${CORE_URL}/api/settings`,
        { method: "POST", body: { ai_provider: provider, ai_model: model } },
        "Couldn't switch the model. Try again.",
      );
      const fresh = await mutateModels();
      if (fresh && (fresh.activeProvider !== provider || (model && fresh.activeModel !== model))) {
        throw new Error("The server didn't keep the new selection. Try again.");
      }
      setStagedModel("");
      toast.success(message);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't switch the model. Try again.");
      return false;
    } finally {
      setSavingModel(false);
    }
  }, [mutateModels]);

  /** Selecting a card only shows its settings; the Assistant keeps its provider until "Use …". */
  const handleProviderChange = useCallback((provider: AiProvider) => {
    setSelectedProvider(provider === serverProvider ? null : provider);
    setStagedModel("");
    // Each card starts untested; a result for another card never carries over.
    setLastTest((prev) => (prev?.provider === provider ? prev : null));
  }, [serverProvider]);

  const handleModelChange = useCallback((model: string) => {
    if (isServerActive) {
      void saveModelSelection(activeProvider, model, `The Assistant now uses ${model}.`);
    } else {
      setStagedModel(model);
    }
  }, [activeProvider, isServerActive, saveModelSelection]);

  async function pullModel() {
    if (!pullName.trim()) return;
    setPulling(true);
    try {
      await settingsRequest(`${CORE_URL}/api/ollama/pull`, { method: "POST", body: { name: pullName.trim() } }, `Couldn't pull ${pullName.trim()}. Check the name and that Ollama is running.`);
      toast.success(`Pulled ${pullName.trim()}`);
      setPullName("");
      mutateOllamaModels();
      mutateModels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Couldn't pull the model. Try again.");
    } finally {
      setPulling(false);
    }
  }

  async function removeModel(name: string) {
    const { confirmed } = await confirm({
      tier: "destructive",
      title: `Remove ${name}?`,
      consequence: `Ollama deletes ${name} from this server's disk.`,
      recovery: "You can pull it again later, which downloads it again.",
      confirmLabel: "Remove model",
      busyLabel: `Removing ${name}…`,
      run: () => settingsRequest(`${CORE_URL}/api/ollama/models/${encodeURIComponent(name)}`, { method: "DELETE" }, `Couldn't remove ${name}. Check that Ollama is running.`),
      receipt: `Removed ${name}`,
    });
    if (!confirmed) return;
    await mutateOllamaModels();
    await mutateModels();
  }

  // ── Test connection ─────────────────────────────────────────────────────
  // A result belongs to the provider that was tested: a test still running
  // when another card is selected must never pass for that card (P0-8).
  const [testingProvider, setTestingProvider] = useState<AiProvider | null>(null);
  const [lastTest, setLastTest] = useState<{ provider: AiProvider; ok: boolean; error?: string } | null>(null);
  const testRequestId = useRef(0);
  const testResult = lastTest?.provider === activeProvider ? lastTest : null;
  const testing = testingProvider === activeProvider;

  const testConnection = async () => {
    const provider = activeProvider;
    const requestId = ++testRequestId.current;
    setTestingProvider(provider);
    setLastTest(null);
    let result: { provider: AiProvider; ok: boolean; error?: string };
    try {
      const res = await fetch(`${CORE_URL}/api/ai/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      result = res.ok && data?.ok === true
        ? { provider, ok: true }
        : { provider, ok: false, error: describeTestFailure(provider, data?.error) };
    } catch {
      result = { provider, ok: false, error: "Couldn't reach the Talome server. Check that it's running, then test again." };
    }
    // A newer test (for this or another card) supersedes this one.
    if (requestId !== testRequestId.current) return;
    setLastTest(result);
    setTestingProvider(null);
  };

  const switchToSelectedProvider = async () => {
    const model = stagedModel || availableModels[0]?.id || "";
    const label = PROVIDER_META[activeProvider].label;
    const { confirmed } = await confirm({
      tier: "soft",
      title: `Switch the Assistant to ${label}?`,
      consequence: `New messages, automations and Intelligence use ${label}${model ? ` (${model})` : ""}. Open conversations switch on their next message.`,
      recovery: `Your ${serverProvider ? PROVIDER_META[serverProvider].label : "current"} settings are kept, so you can switch back here at any time.`,
      confirmLabel: `Use ${label}`,
    });
    if (!confirmed) return;
    const ok = await saveModelSelection(activeProvider, model, `The Assistant now uses ${label}.`);
    if (ok) setSelectedProvider(null);
  };

  // Helper: which providers are configured
  const getConfigured = (p: AiProvider) =>
    modelsData?.providers.find((pd) => pd.provider === p)?.configured ?? false;

  return (
    <div className="grid gap-8">

      {/* ── Step 1: Choose provider ────────────────────────── */}
      <section className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Choose a provider to set it up. The Assistant keeps using its current provider until you test the new one and choose to use it.
        </p>
        {modelsError && !modelsData ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-status-critical">
            <HugeiconsIcon icon={AlertCircleIcon} size={14} aria-hidden="true" />
            Couldn&apos;t load AI providers.
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void mutateModels()}>Retry</Button>
          </p>
        ) : null}
        {settingsError ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-status-critical">
            <HugeiconsIcon icon={AlertCircleIcon} size={14} aria-hidden="true" />
            Couldn&apos;t load the saved keys.
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={loadStoredSettings}>Retry</Button>
          </p>
        ) : null}

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {(["anthropic", "openai", "kimi", "ollama"] as const).map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              configured={getConfigured(p)}
              isActive={serverProvider === p}
              isSelected={activeProvider === p}
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
                <p className="text-sm font-medium text-foreground">Anthropic</p>
                {getConfigured("anthropic") && (
                  <span className="text-xs text-muted-foreground">
                    Key saved
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
              label="API key" hint="Required for Claude models"
              id="anthropic-key" placeholder="sk-ant-..."
              storedValue={anthropicKey} isEditing={anthropicEditing}
              onEdit={() => { setAnthropicEditing(true); setAnthropicKey(""); }}
              onChange={setAnthropicKey}
            />
            <SettingsRow className="bg-muted/30 justify-end py-3">
              <Button size="sm" onClick={() => saveKeys("anthropic")} busy={saving} busyLabel="Saving…" className="h-7 text-xs px-4">
                Save
              </Button>
            </SettingsRow>
          </SettingsGroup>
        )}

        {activeProvider === "openai" && (
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <div className="flex items-center gap-2 flex-1">
                <p className="text-sm font-medium text-foreground">OpenAI</p>
                {getConfigured("openai") && (
                  <span className="text-xs text-muted-foreground">
                    Key saved
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
              label="API key" hint="Required for GPT models"
              id="openai-key" placeholder="sk-..."
              storedValue={openaiKey} isEditing={openaiEditing}
              onEdit={() => { setOpenaiEditing(true); setOpenaiKey(""); }}
              onChange={setOpenaiKey}
            />
            <SettingsRow className="bg-muted/30 justify-end py-3">
              <Button size="sm" onClick={() => saveKeys("openai")} busy={saving} busyLabel="Saving…" className="h-7 text-xs px-4">
                Save
              </Button>
            </SettingsRow>
          </SettingsGroup>
        )}

        {activeProvider === "kimi" && (
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <div className="flex items-center gap-2 flex-1">
                <p className="text-sm font-medium text-foreground">Kimi</p>
                {getConfigured("kimi") && (
                  <span className="text-xs text-muted-foreground">
                    Key saved
                  </span>
                )}
              </div>
              <a
                href="https://platform.kimi.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
                Get key
              </a>
            </SettingsRow>
            <SecretRow
              label="API key" hint="Required for Kimi models in the Assistant and Intelligence"
              id="kimi-key" placeholder="sk-..."
              storedValue={kimiKey} isEditing={kimiEditing}
              onEdit={() => { setKimiEditing(true); setKimiKey(""); }}
              onChange={setKimiKey}
            />
            <SettingsRow className="bg-muted/30 py-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                API usage is billed by Moonshot. Terminal uses the native Kimi Code login separately.
              </p>
              <Button size="sm" onClick={() => saveKeys("kimi")} busy={saving} busyLabel="Saving…" className="h-7 text-xs px-4">
                Save
              </Button>
            </SettingsRow>
          </SettingsGroup>
        )}

        {activeProvider === "ollama" && (
          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <div className="flex items-center gap-2 flex-1">
                <p className="text-sm font-medium text-foreground">Ollama</p>
                {getConfigured("ollama") && (
                  <span className="text-xs text-muted-foreground">
                    Reachable
                  </span>
                )}
                {ollamaModels.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">
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
                    {formatBytes(m.size)}
                    {m.details?.parameter_size && ` · ${m.details.parameter_size}`}
                    {m.details?.quantization_level && ` · ${m.details.quantization_level}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${m.name}`}
                  title={`Remove ${m.name}`}
                  className="text-muted-foreground hover:text-status-critical shrink-0"
                  onClick={() => void removeModel(m.name)}
                >
                  <HugeiconsIcon icon={Delete01Icon} size={14} aria-hidden="true" />
                </Button>
              </SettingsRow>
            ))}

            <SettingsRow className="gap-2">
              <Input
                placeholder="Model to pull, like llama3.2 or gemma2"
                aria-label="Model to pull"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void pullModel(); }}
                className="h-8 text-sm flex-1 font-mono"
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-8 text-xs px-3 shrink-0"
                busy={pulling}
                busyLabel={`Pulling ${pullName.trim()}…`}
                disabled={!pullName.trim()}
                onClick={() => void pullModel()}
              >
                Pull
              </Button>
            </SettingsRow>

            <SettingsRow className="bg-muted/30 justify-end py-3">
              <Button size="sm" onClick={() => saveKeys("ollama")} busy={saving} busyLabel="Saving…" className="h-7 text-xs px-4">
                Save
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
              <p className="text-sm font-medium text-foreground">Model</p>
            </SettingsRow>
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {PROVIDER_META[activeProvider].label} model
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {activeProvider === "ollama" ? "Models installed on your Ollama server" : isServerActive ? "The model the Assistant uses" : "The model to use after you switch"}
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
        <p className="text-xs text-muted-foreground px-1">
          {activeProvider === "ollama"
            ? "Add the Ollama server URL above and pull a model to get started."
            : `Add your ${PROVIDER_META[activeProvider].label} API key above to get started.`}
        </p>
      )}

      {/* ── Test, then use ────────────────────────────────── */}
      {isConfigured && (
        <div className="grid gap-2 px-1">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant={isServerActive || testResult?.ok ? "outline" : "default"}
              className="h-8 text-xs px-3 shrink-0"
              onClick={() => void testConnection()}
              busy={testing}
              busyLabel={`Testing ${PROVIDER_META[activeProvider].label}…`}
            >
              {testResult ? "Test again" : `Test ${PROVIDER_META[activeProvider].label}`}
            </Button>
            {!isServerActive && (
              <Button
                size="sm"
                className="h-8 text-xs px-3 shrink-0"
                disabled={!testResult?.ok}
                busy={savingModel}
                busyLabel={`Switching to ${PROVIDER_META[activeProvider].label}…`}
                onClick={() => void switchToSelectedProvider()}
              >
                Use {PROVIDER_META[activeProvider].label}
              </Button>
            )}
            <span role="status" aria-live="polite" className="text-xs">
              {testResult?.ok ? (
                <span className="flex items-center gap-1.5 text-status-healthy">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} aria-hidden="true" />
                  Test passed · {PROVIDER_META[activeProvider].label} replied
                </span>
              ) : null}
            </span>
          </div>
          {testResult && !testResult.ok && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-status-critical">
              <HugeiconsIcon icon={AlertCircleIcon} size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              {testResult.error}
            </p>
          )}
          {!isServerActive && !testResult?.ok && (
            <p className="text-xs text-muted-foreground">
              Test {PROVIDER_META[activeProvider].label} before the Assistant switches to it. It keeps using {serverProvider ? PROVIDER_META[serverProvider].label : "its current provider"} until then.
            </p>
          )}
        </div>
      )}

      <VoiceSettings />

      <ConfigureWithAI prompt="I'd like to review my AI provider configuration" />
    </div>
  );
}
