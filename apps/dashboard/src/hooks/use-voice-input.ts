"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { useMotionValue, type MotionValue } from "motion/react";
import { CORE_URL } from "@/lib/constants";
import { sharedAudioContext } from "@/lib/audio-session";

/**
 * Voice input for the assistant.
 *
 * Two engines, chosen automatically:
 * - "server": records with MediaRecorder and transcribes through Talome's
 *   /api/voice/transcribe (an OpenAI-compatible speech-to-text server the admin
 *   configured — can be fully local).
 * - "browser": the browser's own SpeechRecognition, with live words as you speak.
 *   In Chrome this sends audio to Google; Safari recognizes on device.
 *
 * Both need a secure context (HTTPS or localhost) for microphone access.
 */

export type VoiceEngine = "server" | "browser";
export type VoiceStatus = "idle" | "starting" | "listening" | "transcribing";

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
}

interface VoiceCapabilities {
  secure: boolean;
  microphone: boolean;
  recorder: boolean;
  recognition: boolean;
}

let cachedCapabilities: VoiceCapabilities | null = null;
/** What this browser can do — read only on the client, so server and first client render agree. */
function readCapabilities(): VoiceCapabilities {
  cachedCapabilities ??= {
    secure: window.isSecureContext,
    microphone: !!navigator.mediaDevices?.getUserMedia,
    recorder: typeof MediaRecorder !== "undefined",
    recognition: speechRecognitionCtor() !== null,
  };
  return cachedCapabilities;
}
const noSubscription = () => () => undefined;

/** RMS level above which the microphone counts as hearing speech. */
const SPEECH_THRESHOLD = 0.035;

export interface UseVoiceInputOptions {
  /** Live transcript while speaking (browser engine only). */
  onInterim?: (text: string) => void;
  /** Called once speech was heard and then silence lasted `silenceMs`. */
  onSilence?: () => void;
  silenceMs?: number;
}

export interface VoiceInput {
  engine: VoiceEngine | null;
  /** Why voice can't be used here, if it can't */
  unavailableReason: string | null;
  status: VoiceStatus;
  /** Microphone level 0–1, updated every animation frame while listening */
  level: MotionValue<number>;
  error: string | null;
  start: () => Promise<void>;
  /** Stop listening and return the transcript */
  stop: () => Promise<string>;
  /** Stop listening and discard what was heard */
  cancel: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions = {}): VoiceInput {
  const { data: status } = useSWR<{ server: boolean }>(
    `${CORE_URL}/api/voice/status`,
    (url: string) => fetch(url).then((r) => (r.ok ? r.json() : { server: false })),
    { revalidateOnFocus: false },
  );
  // null while server-rendering and hydrating; the real capabilities right after
  const caps = useSyncExternalStore(noSubscription, readCapabilities, () => null);
  const engine: VoiceEngine | null = !caps || !caps.secure || !caps.microphone
    ? null
    : status?.server && caps.recorder
      ? "server"
      : caps.recognition
        ? "browser"
        : null;
  const unavailableReason = !caps
    ? null
    : !caps.secure
      ? "Voice needs a secure connection — open Talome over HTTPS or on localhost."
      : !caps.microphone
        ? "This browser can't access a microphone."
        : engine === null
          ? "This browser has no speech recognition. Configure a speech-to-text server in Settings › AI Provider."
          : null;

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const level = useMotionValue(0);

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const session = useRef<{
    stream: MediaStream;
    audioContext: AudioContext;
    source: MediaStreamAudioSourceNode;
    frame: number;
    recorder?: MediaRecorder;
    chunks: Blob[];
    recognition?: SpeechRecognitionLike;
    finalText: string;
    interimText: string;
    ended?: Promise<void>;
  } | null>(null);

  const teardown = useCallback(() => {
    const current = session.current;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    current.stream.getTracks().forEach((track) => track.stop());
    // The context is shared (and unlocked by a tap on iPad) — just unplug the mic
    current.source.disconnect();
    session.current = null;
    level.set(0);
  }, [level]);

  useEffect(() => () => {
    session.current?.recognition?.abort();
    if (session.current?.recorder?.state === "recording") session.current.recorder.stop();
    teardown();
  }, [teardown]);

  const start = useCallback(async () => {
    if (session.current || !engine) return;
    setError(null);
    setVoiceStatus("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("Microphone access was denied.");
      setVoiceStatus("idle");
      return;
    }

    const audioContext = sharedAudioContext();
    if (audioContext.state === "suspended") await audioContext.resume().catch(() => undefined);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let heardSpeech = false;
    let lastVoiceAt = performance.now();
    let silenceReported = false;

    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / samples.length);
      level.set(Math.min(1, rms * 6));
      const now = performance.now();
      if (rms > SPEECH_THRESHOLD) {
        heardSpeech = true;
        lastVoiceAt = now;
      } else if (heardSpeech && !silenceReported && now - lastVoiceAt > (optionsRef.current.silenceMs ?? 1300)) {
        silenceReported = true;
        optionsRef.current.onSilence?.();
      }
      if (session.current) session.current.frame = requestAnimationFrame(tick);
    };

    session.current = { stream, audioContext, source, frame: 0, chunks: [], finalText: "", interimText: "" };

    if (engine === "server") {
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) session.current?.chunks.push(event.data);
      };
      recorder.start(250);
      session.current.recorder = recorder;
    } else {
      const Recognition = speechRecognitionCtor()!;
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        const current = session.current;
        if (!current) return;
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) current.finalText += result[0].transcript;
          else interim += result[0].transcript;
        }
        current.interimText = interim;
        optionsRef.current.onInterim?.(`${current.finalText}${interim}`.trim());
      };
      recognition.onerror = (event) => {
        if (event.error !== "aborted" && event.error !== "no-speech") setError(`Speech recognition error: ${event.error}`);
      };
      session.current.ended = new Promise<void>((resolve) => {
        recognition.onend = () => resolve();
      });
      recognition.start();
      session.current.recognition = recognition;
    }

    session.current.frame = requestAnimationFrame(tick);
    setVoiceStatus("listening");
  }, [engine, level]);

  const stop = useCallback(async (): Promise<string> => {
    const current = session.current;
    if (!current) return "";

    if (current.recognition) {
      current.recognition.stop();
      await Promise.race([current.ended, new Promise((r) => setTimeout(r, 1500))]);
      const text = `${current.finalText}${current.interimText}`.trim();
      teardown();
      setVoiceStatus("idle");
      return text;
    }

    const recorder = current.recorder;
    if (!recorder) {
      teardown();
      setVoiceStatus("idle");
      return "";
    }
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    const blob = new Blob(current.chunks, { type: recorder.mimeType || "audio/webm" });
    teardown();
    if (blob.size === 0) {
      setVoiceStatus("idle");
      return "";
    }

    setVoiceStatus("transcribing");
    try {
      const language = (navigator.language || "en").slice(0, 2).toLowerCase();
      const res = await fetch(`${CORE_URL}/api/voice/transcribe?language=${language}`, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Couldn't transcribe that.");
        return "";
      }
      return body.text ?? "";
    } catch {
      setError("Couldn't reach the speech-to-text server.");
      return "";
    } finally {
      setVoiceStatus("idle");
    }
  }, [teardown]);

  const cancel = useCallback(() => {
    const current = session.current;
    current?.recognition?.abort();
    if (current?.recorder?.state === "recording") current.recorder.stop();
    teardown();
    setVoiceStatus("idle");
  }, [teardown]);

  return { engine, unavailableReason, status: voiceStatus, level, error, start, stop, cancel };
}
