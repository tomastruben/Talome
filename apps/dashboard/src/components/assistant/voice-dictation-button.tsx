"use client";

import { useEffect, useRef } from "react";
import { motion, useTransform, type MotionStyle, type MotionValue } from "motion/react";
import { toast } from "sonner";
import { HugeiconsIcon, Mic01Icon, AudioWave01Icon } from "@/components/icons";
import { PromptInputButton, usePromptInputController } from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/ui/spinner";
import { useVoiceInput, type VoiceStatus } from "@/hooks/use-voice-input";
import { unlockAudio } from "@/lib/audio-session";

/** Hugeicons waveform follows speech without changing its rounded stroke weight. */
function DictationGlyph({ level, active }: { level: MotionValue<number>; active: boolean }) {
  const amplitude = useTransform(level, (value) => Math.min(1, Math.max(0, value * 1.6)));
  return (
    <motion.span
      className="composer-dictation-glyph relative inline-grid size-5 place-items-center"
      data-active={active}
      style={{ "--dictation-level": amplitude } as MotionStyle}
      aria-hidden
    >
      <HugeiconsIcon icon={Mic01Icon} size={16} strokeWidth={1.5} className="composer-dictation-mic" />
      <HugeiconsIcon icon={AudioWave01Icon} size={16} strokeWidth={1.5} className="composer-dictation-wave absolute" />
    </motion.span>
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
        <HugeiconsIcon icon={Mic01Icon} size={16} strokeWidth={1.5} />
      </PromptInputButton>
    );
  }

  return (
    <PromptInputButton
      tooltip={active ? { content: "Stop dictation", shortcut: "Esc cancels" } : "Dictate"}
      aria-label={voice.status === "transcribing" ? "Transcribing dictation" : active ? "Stop dictation" : "Dictate"}
      aria-pressed={active}
      onClick={() => void toggle()}
      className={active ? "text-foreground bg-muted" : undefined}
      disabled={voice.status === "transcribing"}
    >
      {voice.status === "transcribing" ? (
        <Spinner className="size-4" />
      ) : (
        <DictationGlyph level={voice.level} active={active} />
      )}
    </PromptInputButton>
  );
}
