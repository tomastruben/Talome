"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { ChatStatus } from "ai";
import { HugeiconsIcon, Cancel01Icon } from "@/components/icons";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useSpeechOutput } from "@/hooks/use-speech-output";

type Phase = "listening" | "transcribing" | "thinking" | "speaking";

const PHASE_LABEL: Record<Phase, string> = {
  listening: "Listening",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking",
};

export interface VoiceModeProps {
  open: boolean;
  onClose: () => void;
  /** Send a transcribed message to the assistant */
  onSend: (text: string) => void;
  status: ChatStatus;
  /** Latest assistant message, to read aloud when a reply finishes */
  lastAssistant: { id: string; text: string } | null;
}

/**
 * Hands-free conversation: listen → send after a pause → read the reply aloud →
 * listen again. Tap the orb to finish speaking early or to interrupt a reply.
 */
export function VoiceMode({ open, onClose, onSend, status, lastAssistant }: VoiceModeProps) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("listening");
  const [transcript, setTranscript] = useState("");
  const awaitingReplyAfter = useRef<string | null | undefined>(undefined);
  const sawBusy = useRef(false);
  const finishListeningRef = useRef<() => void>(() => undefined);

  const speechPulse = useMotionValue(0);
  const voice = useVoiceInput({
    onInterim: setTranscript,
    onSilence: () => finishListeningRef.current(),
  });
  const speech = useSpeechOutput(() => {
    speechPulse.set(0.6);
    window.setTimeout(() => speechPulse.set(0.15), 120);
  });

  const listen = useCallback(async () => {
    setTranscript("");
    setPhase("listening");
    await voice.start();
  }, [voice]);

  const finishListening = useCallback(async () => {
    if (voice.status !== "listening") return;
    setPhase("transcribing");
    const text = (await voice.stop()).trim();
    if (!text) {
      void listen();
      return;
    }
    setTranscript(text);
    awaitingReplyAfter.current = lastAssistant?.id ?? null;
    sawBusy.current = false;
    setPhase("thinking");
    onSend(text);
  }, [voice, listen, onSend, lastAssistant?.id]);

  useEffect(() => {
    finishListeningRef.current = () => void finishListening();
  }, [finishListening]);

  // Start listening when opened; stop everything when closed
  useEffect(() => {
    if (!open) return;
    void listen();
    return () => {
      voice.cancel();
      speech.cancel();
      awaitingReplyAfter.current = undefined;
    };
    // Only on open/close
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When the reply is complete, read it aloud, then listen again
  useEffect(() => {
    if (phase !== "thinking") return;
    if (status === "submitted" || status === "streaming") {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current) return;
    if (status === "error") {
      void listen();
      return;
    }
    if (lastAssistant && lastAssistant.id !== awaitingReplyAfter.current) {
      setPhase("speaking");
      void speech.speak(lastAssistant.text).then(() => {
        if (open) void listen();
      });
    }
  }, [phase, status, lastAssistant, speech, listen, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const tapOrb = () => {
    if (phase === "listening") void finishListening();
    else if (phase === "speaking") {
      speech.cancel();
      void listen();
    }
  };

  // Orb follows the microphone while listening and the words while speaking
  const driver = useTransform(() => (phase === "speaking" ? speechPulse.get() : voice.level.get()));
  const target = useTransform(driver, (v) => (reduceMotion ? 1 : 1 + v * 0.22));
  const scale = useSpring(target, { stiffness: 380, damping: 36, mass: 0.5 });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed inset-0 z-[1300] flex flex-col items-center justify-center gap-8 bg-background/85 p-6 backdrop-blur-xl"
        >
          <button
            type="button"
            onClick={tapOrb}
            aria-label={phase === "speaking" ? "Stop speaking" : phase === "listening" ? "Send now" : PHASE_LABEL[phase]}
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
          >
            <motion.span
              style={{ scale }}
              className={`block size-40 rounded-full border transition-colors duration-150 ${
                phase === "thinking" || phase === "transcribing"
                  ? "border-foreground/10 bg-foreground/[0.05]"
                  : "border-foreground/20 bg-foreground/[0.1]"
              }`}
            />
          </button>

          <div className="flex min-h-16 max-w-md flex-col items-center gap-2 text-center">
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={phase}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="text-lg font-medium"
                aria-live="polite"
              >
                {PHASE_LABEL[phase]}
              </motion.p>
            </AnimatePresence>
            <p className="line-clamp-3 text-sm text-muted-foreground">
              {transcript || (phase === "listening" ? "Say something — I'll answer when you pause." : "")}
            </p>
          </div>

          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="End voice conversation"
              className="flex size-12 items-center justify-center rounded-full bg-muted text-foreground transition-colors duration-150 hover:bg-muted/70"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={18} />
            </button>
            <p className="text-xs text-muted-foreground">
              {voice.engine === "browser"
                ? "Using this browser's speech recognition"
                : voice.engine === "server"
                  ? "Transcribed by your Talome server"
                  : voice.unavailableReason}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
