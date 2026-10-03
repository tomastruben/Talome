"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CORE_URL } from "@/lib/constants";
import { microphoneErrorMessage } from "@/lib/microphone-error";
import { microphonePromptExplanation, readVoiceEnvironment, type VoiceEnvironment } from "@/lib/voice-diagnostics";
import { SectionLabel, SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";

const statusSchema = z.object({ server: z.boolean(), model: z.string().nullable(), live: z.object({ model: z.string(), voice: z.string() }).nullable() });
const transcriptSchema = z.object({ ok: z.boolean(), text: z.string().optional(), error: z.string().optional() });
type VoiceReadiness = z.infer<typeof statusSchema>;

export function VoiceDiagnostics() {
  const [environment, setEnvironment] = useState<VoiceEnvironment | null>(null);
  const [readiness, setReadiness] = useState<VoiceReadiness | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [clip, setClip] = useState<File | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const requestId = useRef(0);
  const upload = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setEnvironment(await readVoiceEnvironment());
    setLoadError(null);
    try {
      const response = await fetch(`${CORE_URL}/api/voice/status`, { credentials: "include", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Voice status request failed (${response.status}).`);
      setReadiness(statusSchema.parse(await response.json()));
    } catch (error) {
      setReadiness(null);
      setLoadError(error instanceof Error ? error.message : "Couldn't read voice status.");
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; upload.current?.abort(); };
  }, [refresh]);

  const testMicrophone = async () => {
    const id = ++requestId.current;
    setTesting(true);
    setResult(null);
    const started = performance.now();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new TypeError("getUserMedia is unavailable");
      // Request before any await: preserve the button's user gesture in Safari.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let active = false;
      try { active = stream.getAudioTracks().some((track) => track.readyState === "live"); }
      finally { stream.getTracks().forEach((track) => track.stop()); }
      if (id !== requestId.current) return;
      setResult(active ? `Capture succeeded in ${Math.round(performance.now() - started)} ms. The microphone is now released. No audio was recorded or sent.` : "Capture returned no live audio track.");
    } catch (error) {
      const explanation = await microphoneErrorMessage(error);
      if (id !== requestId.current) return;
      const name = error instanceof DOMException || error instanceof Error ? error.name : "Unknown error";
      setResult(`${name} after ${Math.round(performance.now() - started)} ms: ${explanation}`);
    } finally {
      if (id === requestId.current) { setTesting(false); void refresh(); }
    }
  };

  const transcribe = async () => {
    if (!clip || !readiness?.server) return;
    if (clip.size > 5 * 1024 * 1024 || clip.size === 0) {
      setTranscriptionError("Choose a non-empty audio clip smaller than 5 MB.");
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    setTranscribing(true); setTranscript(null); setTranscriptionError(null);
    try {
      const response = await fetch(`${CORE_URL}/api/voice/transcribe`, {
        method: "POST", credentials: "include", headers: { "Content-Type": clip.type || "audio/webm" }, body: clip,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65000)]),
      });
      const body = transcriptSchema.parse(await response.json());
      if (!response.ok || !body.ok) throw new Error(body.error || `Transcription failed (${response.status}).`);
      setTranscript(body.text?.trim() || "The server returned no words. Try a short clip with clear speech.");
    } catch (error) {
      if (!controller.signal.aborted) setTranscriptionError(error instanceof Error ? error.message : "Transcription failed.");
    } finally {
      if (!controller.signal.aborted) setTranscribing(false);
    }
  };

  const checks = environment ? [
    ["Page origin", environment.origin],
    ["Context", environment.embedded ? "Desktop iframe" : "Top-level page"],
    ["Secure context", environment.secure ? "Yes" : "No"],
    ["Microphone API", environment.capture ? "Available" : "Unavailable"],
    ["Microphone policy", environment.policy === null ? "Not exposed by browser" : environment.policy ? "Allowed" : "Blocked"],
    ["Microphone permission", environment.permission],
    ["Audio recording", environment.recorder ? "Supported" : "Unsupported"],
    ["Browser speech recognition", environment.recognition ? "Supported (capture not tested)" : "Unsupported"],
    ["Server transcription", readiness ? readiness.server ? `Configured (${readiness.model}) — connection not tested` : "Not configured" : "Unknown"],
    ["Live voice", readiness ? readiness.live ? `Configured (${readiness.live.model}) — connection not tested` : "Not configured" : "Unknown"],
  ] : [];

  return <div className="grid gap-6">
    <div className="space-y-2">
      <SectionLabel>Voice diagnostics</SectionLabel>
      <p className="text-sm text-muted-foreground">Check this in the browser where voice fails. Opening this tool does not access your microphone.</p>
    </div>
    <SettingsGroup>
      {checks.map(([label, value]) => <SettingsRow key={label} className="flex-wrap gap-2"><span className="text-sm">{label}</span><span className="ml-auto max-w-full break-words text-sm text-muted-foreground">{value}</span></SettingsRow>)}
    </SettingsGroup>
    {loadError && <p role="alert" className="text-sm text-status-critical">{loadError}</p>}
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{environment && microphonePromptExplanation(environment)}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void testMicrophone()} disabled={testing || !environment}>Test microphone</Button>
        {testing && <Button variant="outline" onClick={() => { requestId.current += 1; setTesting(false); setResult("Test canceled. Any capture granted later will be released immediately."); }}>Cancel test</Button>}
        <Button variant="ghost" onClick={() => void refresh()}>Refresh checks</Button>
        <CopyButton label="Copy voice diagnostic report" text="Copy report" size="sm" disabled={!environment} value={() => JSON.stringify({ capturedAt: new Date().toISOString(), browser: navigator.userAgent, environment, readiness, loadError, microphoneTest: result, transcriptionError }, null, 2)} />
        {environment?.embedded && <Button variant="ghost" asChild><a href="/dashboard/settings/voice-diagnostics" target="_blank" rel="noopener noreferrer" data-desktop-navigation="bypass">Open outside desktop</a></Button>}
      </div>
      <p role="status" className="text-sm break-words">{testing ? "Waiting for the browser's microphone request. Check for a permission prompt; you can cancel this test." : result}</p>
      <p className="text-sm text-muted-foreground">In Safari: Settings → Websites → Microphone → this site → Ask. Also check macOS System Settings → Privacy & Security → Microphone for the browser. A granted permission does not guarantee capture succeeds.</p>
    </div>
    <div className="space-y-3">
      <SectionLabel>Transcription test</SectionLabel>
      <p className="text-sm text-muted-foreground">Choose a short WAV, M4A, Ogg, or WebM speech clip (up to 5 MB). Transcribe sends it to your configured speech-to-text server. The result stays here and is not sent to chat.</p>
      <Label htmlFor="voice-test-clip">Audio clip</Label>
      <Input id="voice-test-clip" type="file" accept="audio/wav,audio/mp4,audio/ogg,audio/webm,.wav,.m4a,.ogg,.webm" disabled={transcribing} onChange={(event) => { setClip(event.target.files?.[0] ?? null); setTranscript(null); setTranscriptionError(null); }} />
      <Button variant="outline" disabled={!clip || !readiness?.server || transcribing} onClick={() => void transcribe()}>Transcribe test clip</Button>
      {!readiness?.server && <p className="text-sm text-muted-foreground">Configure a speech-to-text server in Settings → AI Provider to run this test. Live voice uses a separate service.</p>}
      <p role="status" className="text-sm whitespace-pre-wrap break-words">{transcribing ? "Transcribing…" : transcript}</p>
      {transcriptionError && <p role="alert" className="text-sm text-status-critical">{transcriptionError}</p>}
    </div>
  </div>;
}
