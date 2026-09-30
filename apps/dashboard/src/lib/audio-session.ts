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

export function sharedAudioContext(): AudioContext {
  if (!shared || shared.state === "closed") shared = new AudioContext();
  return shared;
}

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const ctx = sharedAudioContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
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
