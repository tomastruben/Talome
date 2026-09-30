"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, SecretRow, TextRow, ToggleRow } from "@/components/settings/settings-primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CORE_URL } from "@/lib/constants";

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

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.voice_stt_url) setUrl(data.voice_stt_url);
        if (data.voice_stt_model) setModel(data.voice_stt_model);
        if (data.voice_stt_key) setKey(data.voice_stt_key);
        setLiveEnabled(data.voice_live_enabled !== "false");
        if (data.voice_live_voice) setLiveVoice(data.voice_live_voice);
        if (data.voice_live_model) setLiveModel(data.voice_live_model);
        setHasOpenAiKey(Boolean(data.openai_key));
      })
      .catch(() => {});
    fetch(`${CORE_URL}/api/voice/status`)
      .then((r) => r.json())
      .then((data: { liveVoices?: string[] }) => {
        if (data.liveVoices?.length) setVoices(data.liveVoices);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
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
      const res = await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      setKeyEditing(false);
      toast.success("Voice settings saved");
    } catch {
      toast.error("Failed to save voice settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground px-1">Voice</p>
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
                  {voices.map((v) => (
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
          <Button size="sm" className="h-7 text-xs px-4" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
