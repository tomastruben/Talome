"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DesktopLink } from "@/components/desktop/desktop-link";
import { toast } from "sonner";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  SectionLabel,
  SettingsApprovalRequiredError,
  SettingsGroup,
  SettingsRow,
  SecretRow,
  TextRow,
  ToggleRow,
  settingsFetcher,
  settingsRequest,
} from "@/components/settings/settings-primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { approvalHref } from "@/components/trust/format";
import { CORE_URL } from "@/lib/constants";
import { toastWarning } from "@/lib/toast";

const SAVE_FALLBACK = "Couldn't save the voice settings. Check that the Talome server is reachable, then try again.";

/**
 * Speech-to-text for voice input. Any OpenAI-compatible transcription endpoint
 * works — a local faster-whisper server keeps audio on your network.
 */
export function VoiceSettings() {
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [keyEditing, setKeyEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [liveVoice, setLiveVoice] = useState("marin");
  const [liveModel, setLiveModel] = useState("");
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [voices, setVoices] = useState<string[]>(["marin"]);
  // Save stays off until the stored values are on screen: saving the defaults
  // over settings that failed to load would overwrite them.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A save the server held for approval: nothing is stored until it's approved.
  const [heldApprovalId, setHeldApprovalId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    settingsFetcher<Record<string, string>>(`${CORE_URL}/api/settings`)
      .then((data) => {
        setUrl(data.voice_stt_url ?? "");
        setModel(data.voice_stt_model ?? "");
        setKey(data.voice_stt_key ?? "");
        setKeyEditing(false);
        setLiveEnabled(data.voice_live_enabled !== "false");
        if (data.voice_live_voice) setLiveVoice(data.voice_live_voice);
        setLiveModel(data.voice_live_model ?? "");
        setHasOpenAiKey(Boolean(data.openai_key));
        setLoaded(true);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "Couldn't load the voice settings."));
    // The voice list is optional: without it the select offers the stored voice.
    settingsFetcher<{ liveVoices?: string[] }>(`${CORE_URL}/api/voice/status`)
      .then((data) => {
        if (data.liveVoices?.length) setVoices(data.liveVoices);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    try {
      const body: Record<string, string> = {
        voice_stt_url: url.trim(),
        voice_stt_model: model.trim(),
        voice_live_enabled: liveEnabled ? "true" : "false",
        voice_live_voice: liveVoice,
        voice_live_model: liveModel.trim(),
      };
      if (keyEditing || !key) body.voice_stt_key = key;
      await settingsRequest(`${CORE_URL}/api/settings`, { method: "POST", body }, SAVE_FALLBACK);
      setKeyEditing(false);
      setHeldApprovalId(null);
      toast.success("Voice settings saved");
    } catch (err) {
      if (err instanceof SettingsApprovalRequiredError) {
        // Re-pointing the speech-to-text server while an API key is stored
        // would send that key to the new host: the owner approves it first.
        setHeldApprovalId(err.approval.approvalId);
        toastWarning("Waiting for approval", {
          description: "Nothing is saved until the change is approved in Approvals.",
        });
      } else {
        toast.error(err instanceof Error ? err.message : SAVE_FALLBACK);
      }
    } finally {
      setSaving(false);
    }
  };

  const voiceOptions = voices.includes(liveVoice) ? voices : [liveVoice, ...voices];

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Voice</SectionLabel>
        <Button variant="ghost" size="sm" asChild><DesktopLink href="/dashboard/settings/voice-diagnostics">Voice diagnostics</DesktopLink></Button>
      </div>
      {loadError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 px-1 text-sm text-status-critical">
          <HugeiconsIcon icon={AlertCircleIcon} size={14} aria-hidden="true" />
          Couldn&apos;t load the voice settings.
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={load}>Retry</Button>
        </p>
      ) : null}
      <SettingsGroup>
        <ToggleRow
          label="Full-duplex conversations"
          hint={
            hasOpenAiKey
              ? "Talk with GPT-Live: it listens while it speaks, so you can interrupt. Uses your OpenAI key; Talome does the work behind it."
              : "Add an OpenAI key above to talk with GPT-Live. Until then, voice mode listens, then answers."
          }
          checked={liveEnabled && hasOpenAiKey}
          onCheckedChange={setLiveEnabled}
        />
        {liveEnabled && hasOpenAiKey && (
          <>
            <SettingsRow>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Voice</p>
                <p className="text-xs text-muted-foreground mt-0.5">How Talome sounds</p>
              </div>
              <Select value={liveVoice} onValueChange={setLiveVoice}>
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="GPT-Live voice">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {voiceOptions.map((v) => (
                    <SelectItem key={v} value={v} className="text-xs capitalize">
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <TextRow
              label="Live model"
              hint="Leave empty for gpt-live-1"
              id="voice-live-model"
              placeholder="gpt-live-1"
              value={liveModel}
              onChange={setLiveModel}
            />
          </>
        )}
      </SettingsGroup>
      <SettingsGroup>
        <TextRow
          label="Speech-to-text server"
          hint="OpenAI-compatible, e.g. a local faster-whisper server (http://whisper:8000/v1). Leave empty to use the browser's recognition."
          id="voice-stt-url"
          placeholder="http://localhost:8000/v1"
          value={url}
          onChange={setUrl}
        />
        <TextRow
          label="Model"
          hint="whisper-1 for OpenAI; the model name your server expects otherwise"
          id="voice-stt-model"
          placeholder="whisper-1"
          value={model}
          onChange={setModel}
        />
        <SecretRow
          label="API key"
          hint="Only if the server requires one"
          id="voice-stt-key"
          placeholder="Optional"
          storedValue={key}
          isEditing={keyEditing}
          onEdit={() => {
            setKeyEditing(true);
            setKey("");
          }}
          onChange={(value) => {
            setKeyEditing(true);
            setKey(value);
          }}
        />
        <SettingsRow className="justify-end py-3">
          {heldApprovalId ? (
            <p role="status" className="mr-auto text-xs text-status-warning">
              Waiting for approval: the speech-to-text server receives your stored API key, so this change is saved only once it&apos;s approved.{" "}
              <Link
                href={approvalHref(heldApprovalId)}
                className="rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Review
              </Link>
            </p>
          ) : null}
          <Button size="sm" className="h-7 text-xs px-4" busy={saving} busyLabel="Saving…" disabled={!loaded} onClick={() => void save()}>
            Save
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
