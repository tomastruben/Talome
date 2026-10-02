"use client";

import { microphoneErrorMessage } from "@/lib/microphone-error";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import { getWsUrl } from "@/lib/constants";
import { sharedAudioContext } from "@/lib/audio-session";

/**
 * Full-duplex voice with OpenAI GPT-Live, relayed through Talome
 * (`/api/voice/live`). The model listens while it speaks, so there are no
 * turns to manage here: the microphone streams continuously and replies play
 * as they arrive. When the model needs Talome it creates a delegation; we
 * answer it through `onDelegate` (the regular assistant chat) and hand the
 * reply back as commentary for the model to speak.
 */

export type LiveState = "idle" | "connecting" | "live" | "ended";
export type LiveActivity = "listening" | "speaking" | "working";

export interface LiveHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface UseLiveVoiceOptions {
  /** Ask Talome; resolves with the text the voice should relay. */
  onDelegate: (request: string) => Promise<string>;
  /** Recent conversation, so the voice knows what was said before */
  history?: () => LiveHistoryItem[];
}

export interface LiveVoice {
  state: LiveState;
  activity: LiveActivity;
  error: string | null;
  /** Last thing said, by either side */
  caption: { role: "user" | "assistant"; text: string } | null;
  userLevel: MotionValue<number>;
  agentLevel: MotionValue<number>;
  start: () => Promise<void>;
  stop: () => void;
}

const RATE = 24000;
/** Commentary is capped at ~500 tokens; keep well under it. */
const MAX_COMMENTARY_CHARS = 1600;

/** Resamples whatever rate the device runs at to 24 kHz PCM16, 40 ms per message. */
const CAPTURE_WORKLET = `
class TalomePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${RATE};
    this.pos = 0;
    this.out = new Int16Array(${RATE / 25});
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = ch[i];
      const b = i + 1 < ch.length ? ch[i + 1] : a;
      const s = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer.slice(0));
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("talome-pcm-capture", TalomePcmCapture);
`;

/** Contexts that already have the capture worklet (it can be registered once per context) */
const workletContexts = new WeakSet<BaseAudioContext>();

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function pcm16ToFloat(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const samples = new Float32Array(binary.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    samples[i] = v / 0x8000;
  }
  return samples;
}

/** Keep what the voice relays short, ending on a sentence where possible. */
export function clipCommentary(text: string, max = MAX_COMMENTARY_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

export function liveVoiceUrl(): string {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    return `wss://${window.location.host}/api/voice/live`;
  }
  return `${getWsUrl()}/api/voice/live`;
}

function rms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

export function useLiveVoice({ onDelegate, history }: UseLiveVoiceOptions): LiveVoice {
  const [state, setState] = useState<LiveState>("idle");
  const [activity, setActivity] = useState<LiveActivity>("listening");
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState<LiveVoice["caption"]>(null);
  const userLevel = useMotionValue(0);
  const agentLevel = useMotionValue(0);

  const optionsRef = useRef({ onDelegate, history });
  useEffect(() => {
    optionsRef.current = { onDelegate, history };
  });

  const session = useRef<{
    ws: WebSocket;
    ctx: AudioContext;
    stream: MediaStream;
    nodes: AudioNode[];
    capture: AudioWorkletNode | null;
    output: GainNode;
    sources: Set<AudioBufferSourceNode>;
    playhead: number;
    lastOutputAt: number;
    started: boolean;
    frame: number;
    heard: string;
    captionRole: "user" | "assistant" | null;
    captionText: string;
    delegations: Promise<void>;
    pending: number;
  } | null>(null);

  const teardown = useCallback(() => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    cancelAnimationFrame(s.frame);
    if (s.ws.readyState <= 1) {
      try {
        if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // closing anyway
      }
      s.ws.close();
    }
    s.sources.forEach((src) => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    });
    s.stream.getTracks().forEach((t) => t.stop());
    // The context is shared (and unlocked by a tap on iPad) — unplug this session's nodes
    s.nodes.forEach((node) => node.disconnect());
    userLevel.set(0);
    agentLevel.set(0);
  }, [userLevel, agentLevel]);

  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    teardown();
    setState("ended");
    setActivity("listening");
  }, [teardown]);

  const start = useCallback(async () => {
    if (session.current) return;
    setError(null);
    setCaption(null);
    setActivity("listening");
    setState("connecting");

    let stream: MediaStream;
    try {
      // Echo cancellation matters: the model hears the room while it talks
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      setError(await microphoneErrorMessage(err));
      setState("ended");
      return;
    }

    const ctx = sharedAudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    const output = ctx.createGain();
    const outAnalyser = ctx.createAnalyser();
    outAnalyser.fftSize = 512;
    output.connect(outAnalyser);
    outAnalyser.connect(ctx.destination);

    const micSource = ctx.createMediaStreamSource(stream);
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micSource.connect(micAnalyser);

    const ws = new WebSocket(liveVoiceUrl());
    const s = {
      ws,
      ctx,
      stream,
      nodes: [output, outAnalyser, micSource, micAnalyser] as AudioNode[],
      capture: null as AudioWorkletNode | null,
      output,
      sources: new Set<AudioBufferSourceNode>(),
      playhead: 0,
      lastOutputAt: 0,
      started: false,
      frame: 0,
      heard: "",
      captionRole: null as "user" | "assistant" | null,
      captionText: "",
      delegations: Promise.resolve(),
      pending: 0,
    };
    session.current = s;

    try {
      if (!workletContexts.has(ctx)) {
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        workletContexts.add(ctx);
      }
      const capture = new AudioWorkletNode(ctx, "talome-pcm-capture");
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (s.started && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "session.input_audio.append", audio: toBase64(event.data) }));
        }
      };
      micSource.connect(capture);
      // Keep the worklet pulled without making the microphone audible
      const mute = ctx.createGain();
      mute.gain.value = 0;
      capture.connect(mute).connect(ctx.destination);
      s.capture = capture;
      s.nodes.push(capture, mute);
    } catch {
      setError("This browser can't stream audio.");
      stop();
      return;
    }

    let lastCaptionAt = 0;
    const updateCaption = (role: "user" | "assistant", delta: string) => {
      const now = performance.now();
      // A new speaker, or a pause, starts a new line
      if (s.captionRole !== role || now - lastCaptionAt > 1200) {
        s.captionRole = role;
        s.captionText = "";
        delta = delta.trimStart();
      }
      lastCaptionAt = now;
      s.captionText = `${s.captionText}${delta}`.slice(-240);
      setCaption({ role, text: s.captionText.trim() });
    };

    const stopPlayback = () => {
      s.sources.forEach((src) => {
        try {
          src.stop();
        } catch {
          // already stopped
        }
      });
      s.sources.clear();
      s.playhead = ctx.currentTime;
    };

    const delegate = (id: string) => {
      const request = s.heard.trim() || s.captionText.trim();
      s.heard = "";
      s.pending += 1;
      setActivity("working");
      // One at a time: the chat runs one reply at a time too
      s.delegations = s.delegations.then(async () => {
        let answer: string;
        try {
          answer = await optionsRef.current.onDelegate(request);
        } catch (err) {
          answer = `That didn't work: ${err instanceof Error ? err.message : "something went wrong"}.`;
        }
        if (session.current !== s) return;
        s.pending -= 1;
        if (s.pending === 0) setActivity("listening");
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "session.commentary.append", delegation_id: id, content: clipCommentary(answer) || "Done." }));
        }
      });
    };

    ws.onopen = () => {
      const recent = (optionsRef.current.history?.() ?? []).slice(-12);
      ws.send(JSON.stringify({ type: "talome.start", history: recent }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let msg: { type?: string; [key: string]: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "session.started":
          s.started = true;
          setState("live");
          break;
        case "session.output_audio.delta": {
          const samples = pcm16ToFloat(String(msg.delta ?? ""));
          if (samples.length === 0) break;
          const buffer = ctx.createBuffer(1, samples.length, RATE);
          buffer.copyToChannel(samples, 0);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(output);
          const at = Math.max(ctx.currentTime + 0.03, s.playhead);
          src.start(at);
          s.playhead = at + buffer.duration;
          s.lastOutputAt = performance.now();
          s.sources.add(src);
          src.onended = () => s.sources.delete(src);
          break;
        }
        case "session.input_transcript.delta": {
          const delta = String(msg.delta ?? "");
          s.heard += delta;
          updateCaption("user", delta);
          // Barge-in: the model stopped sending, so drop what's still queued
          if (delta.trim() && s.sources.size > 0 && performance.now() - s.lastOutputAt > 250) stopPlayback();
          break;
        }
        case "session.output_transcript.delta":
          updateCaption("assistant", String(msg.delta ?? ""));
          break;
        case "session.delegation.created": {
          const d = msg.delegation as { id?: string; target?: string } | undefined;
          if (d?.id && (d.target ?? "client") === "client") delegate(d.id);
          break;
        }
        case "talome.error":
          setError(String(msg.message ?? "Voice session ended."));
          break;
        case "error": {
          const e = msg.error as { message?: string } | undefined;
          setError(e?.message ?? "GPT-Live reported an error.");
          break;
        }
        case "session.closed":
          stop();
          break;
      }
    };
    ws.onclose = () => {
      if (session.current === s) stop();
    };

    // Levels for the orb and glow, and who's talking
    const micSamples = new Float32Array(micAnalyser.fftSize);
    const outSamples = new Float32Array(outAnalyser.fftSize);
    let speaking = false;
    const tick = () => {
      if (session.current !== s) return;
      userLevel.set(Math.min(1, rms(micAnalyser, micSamples) * 6));
      const out = rms(outAnalyser, outSamples);
      agentLevel.set(Math.min(1, out * 6));
      const nowSpeaking = s.playhead > ctx.currentTime;
      if (nowSpeaking !== speaking) {
        speaking = nowSpeaking;
        if (s.pending === 0) setActivity(nowSpeaking ? "speaking" : "listening");
      }
      s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  }, [stop, userLevel, agentLevel]);

  return { state, activity, error, caption, userLevel, agentLevel, start, stop };
}
