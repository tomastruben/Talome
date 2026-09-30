"use client";

import { useEffect, useRef } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { toast } from "sonner";
import { HugeiconsIcon, Mic01Icon } from "@/components/icons";
import { PromptInputButton, usePromptInputController } from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/ui/spinner";
import { useVoiceInput, type VoiceStatus } from "@/hooks/use-voice-input";
import { unlockAudio } from "@/lib/audio-session";

/** Three bars that follow the microphone level. */
function LevelBars({ level }: { level: MotionValue<number> }) {
  const a = useTransform(level, (v) => 0.35 + Math.min(1, v * 1.4) * 0.65);
  const b = useTransform(level, (v) => 0.35 + Math.min(1, v * 2) * 0.65);
  const c = useTransform(level, (v) => 0.35 + Math.min(1, v * 1.1) * 0.65);
  return (
    <span className="flex h-3.5 items-center gap-0.5" aria-hidden>
      {[a, b, c].map((scaleY, i) => (
        <motion.span key={i} className="h-full w-0.5 origin-center rounded-full bg-current" style={{ scaleY }} />
      ))}
    </span>
  );
}

/**
 * Dictate into the composer. Words stream in live with the browser engine; with a
 * speech-to-text server they arrive when you stop. Esc cancels.
 */
export interface VoiceDictationButtonProps {
  /** Follows the microphone, e.g. to light the composer while you speak */
  onStatusChange?: (status: VoiceStatus, level: MotionValue<number>) => void;
  /** Dictation put words into the composer */
  onTranscript?: () => void;
}

export function VoiceDictationButton({ onStatusChange, onTranscript }: VoiceDictationButtonProps = {}) {
  const controller = usePromptInputController();
  const prefix = useRef("");
  const voice = useVoiceInput({
    onInterim: (text) => controller.textInput.setInput(`${prefix.current}${text}`),
  });
  const active = voice.status === "listening" || voice.status === "starting";

  useEffect(() => {
    if (voice.error) toast.error(voice.error);
  }, [voice.error]);

  useEffect(() => {
    onStatusChange?.(voice.status, voice.level);
  }, [voice.status, voice.level, onStatusChange]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      voice.cancel();
      controller.textInput.setInput(prefix.current.trimEnd());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, voice, controller.textInput]);

  const toggle = async () => {
    // Still inside the tap: iPad only lets audio start here
    unlockAudio();
    if (active) {
      const text = await voice.stop();
      if (text) {
        controller.textInput.setInput(`${prefix.current}${text}`);
        onTranscript?.();
      }
      return;
    }
    const current = controller.textInput.value;
    prefix.current = current && !current.endsWith(" ") ? `${current} ` : current;
    await voice.start();
  };

  if (voice.unavailableReason) {
    return (
      <PromptInputButton tooltip={voice.unavailableReason} disabled aria-label="Dictation unavailable" className="opacity-40">
        <HugeiconsIcon icon={Mic01Icon} size={16} />
      </PromptInputButton>
    );
  }

  return (
    <PromptInputButton
      tooltip={active ? { content: "Stop dictation", shortcut: "Esc cancels" } : "Dictate"}
      aria-label={active ? "Stop dictation" : "Dictate"}
      aria-pressed={active}
      onClick={() => void toggle()}
      className={active ? "text-foreground bg-muted" : undefined}
      disabled={voice.status === "transcribing"}
    >
      {voice.status === "transcribing" ? (
        <Spinner className="size-4" />
      ) : active ? (
        <LevelBars level={voice.level} />
      ) : (
        <HugeiconsIcon icon={Mic01Icon} size={16} />
      )}
    </PromptInputButton>
  );
}
