"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, SecretRow, TextRow } from "@/components/settings/settings-primitives";
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

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.voice_stt_url) setUrl(data.voice_stt_url);
        if (data.voice_stt_model) setModel(data.voice_stt_model);
        if (data.voice_stt_key) setKey(data.voice_stt_key);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = { voice_stt_url: url.trim(), voice_stt_model: model.trim() };
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
