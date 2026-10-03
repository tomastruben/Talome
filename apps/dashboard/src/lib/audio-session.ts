"use client";

/**
 * One audio context for voice, unlocked by a tap.
 *
 * iPadOS and iOS only let audio start inside a user gesture: a context created
 * after an `await` (a permission prompt, a fetch) stays suspended, so the
 * microphone meter reads silence and replies never play. Call `unlockAudio()`
 * synchronously in the tap that starts voice, and reuse `sharedAudioContext()`
 * afterwards instead of creating new contexts.
 */

let shared: AudioContext | null = null;
const mediaOutputs = new WeakMap<AudioContext, { destination: MediaStreamAudioDestinationNode; audio: HTMLAudioElement }>();

/** WebKit's media player owns duplex speaker routing more reliably than a direct Web Audio sink. */
export function voiceAudioDestination(ctx: AudioContext): AudioNode {
  const webkit = /Safari\/|iPad|iPhone|iPod/.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
  if (!webkit) return ctx.destination;
  let output = mediaOutputs.get(ctx);
  if (!output) {
    const destination = ctx.createMediaStreamDestination();
    const audio = document.createElement("audio");
    audio.hidden = true;
    audio.setAttribute("playsinline", "");
    audio.srcObject = destination.stream;
    document.body.appendChild(audio);
    output = { destination, audio };
    mediaOutputs.set(ctx, output);
  }
  return output.destination;
}

export function resumeVoiceAudio(ctx: AudioContext): Promise<void> {
  voiceAudioDestination(ctx);
  const audio = mediaOutputs.get(ctx)?.audio;
  // Start both synchronously: awaiting resume() first loses Safari's tap activation.
  const playback = audio?.play();
  return Promise.all([ctx.resume(), playback]).then(() => undefined);
}

export function voiceAudioBlocked(ctx: AudioContext): boolean {
  return ctx.state !== "running" || (mediaOutputs.get(ctx)?.audio.paused ?? false);
}

export function pauseVoiceAudio(ctx: AudioContext): void {
  mediaOutputs.get(ctx)?.audio.pause();
}

export function sharedAudioContext(): AudioContext {
  if (!shared || shared.state === "closed") {
    if (shared) mediaOutputs.get(shared)?.audio.remove();
    shared = new AudioContext();
  }
  return shared;
}

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const ctx = sharedAudioContext();
    void resumeVoiceAudio(ctx).catch(() => undefined);
    // WebKit also needs a source started during the gesture to unlock output.
    const primer = ctx.createBufferSource();
    primer.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    primer.connect(ctx.destination);
    primer.onended = () => primer.disconnect();
    primer.start();
  } catch {
    // No Web Audio — voice will explain what's missing
  }
  try {
    // Speech synthesis needs its own first utterance inside the gesture on iOS
    if ("speechSynthesis" in window && !window.speechSynthesis.speaking) {
      const primer = new SpeechSynthesisUtterance("");
      primer.volume = 0;
      window.speechSynthesis.speak(primer);
    }
  } catch {
    // Replies will be shown instead of spoken
  }
}

/** Safari can change audio routing when microphone capture begins. */
export function acquireVoiceAudioSession(): () => void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  const audio = nav.audioSession;
  if (!audio) return () => undefined;
  const previous = audio.type;
  try {
    audio.type = "play-and-record";
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      if (audio.type === "play-and-record") audio.type = previous;
    } catch {
      // Optional browser API; ordinary playback remains available.
    }
  };
}
