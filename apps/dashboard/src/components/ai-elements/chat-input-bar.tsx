"use client";

import type { ChatStatus, FileUIPart } from "ai";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { MotionValue } from "motion/react";
import { useTheme } from "next-themes";
import { VoiceBeam } from "voice-glow";
import Image from "next/image";
import { toast } from "sonner";
import {
  HugeiconsIcon,
  FileAttachmentIcon,
  Cancel01Icon,
  Image01Icon,
} from "@/components/icons";
import {
  PromptInput,
  PromptInputButton,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { VoiceDictationButton } from "@/components/assistant/voice-dictation-button";
import type { VoiceStatus } from "@/hooks/use-voice-input";
import { unlockAudio } from "@/lib/audio-session";
import { AudioWave01Icon } from "@/components/icons";

// ── Attachment preview ──────────────────────────────────────────────────────

function AttachmentPreviewList() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith("image/");

        return (
          <div
            key={file.id}
            className="flex max-w-full items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-2.5 py-2"
          >
            {isImage && file.url ? (
              <Image
                alt={file.filename || "Attachment preview"}
                className="size-10 shrink-0 rounded-lg object-cover"
                src={file.url}
                unoptimized
                width={40}
                height={40}
              />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <HugeiconsIcon
                  icon={isImage ? Image01Icon : FileAttachmentIcon}
                  size={16}
                />
              </div>
            )}

            <div className="min-w-0">
              <div className="truncate text-xs font-medium">
                {file.filename || "Attachment"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {isImage ? "Image" : file.mediaType || "File"}
              </div>
            </div>

            <button
              aria-label={`Remove ${file.filename || "attachment"}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => attachments.remove(file.id)}
              type="button"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Shared input bar ────────────────────────────────────────────────────────

export interface ChatInputBarProps {
  status: ChatStatus;
  onSubmit: (message: { text: string; files: FileUIPart[] }) => void | Promise<void>;
  onStop?: () => void;
  placeholder?: string;
  extraTools?: ReactNode;
  maxWidth?: string;
  /** Show the voice-conversation button; called when it's pressed */
  onVoiceMode?: () => void;
}

export function ChatInputBar({
  status,
  onSubmit,
  onStop,
  placeholder = "Ask Talome anything...",
  extraTools,
  maxWidth = "max-w-2xl",
  onVoiceMode,
}: ChatInputBarProps) {
  const isActive = status === "streaming" || status === "submitted";
  const { resolvedTheme } = useTheme();

  // The composer glows with your voice while you dictate, then sweeps while
  // the words are transcribed and the reply to them is written.
  const [dictation, setDictation] = useState<{ status: VoiceStatus; level: MotionValue<number> | null }>({
    status: "idle",
    level: null,
  });
  const [dictated, setDictated] = useState(false);
  const [voiceTurn, setVoiceTurn] = useState(false);
  const handleDictationStatus = useCallback((next: VoiceStatus, level: MotionValue<number>) => {
    setDictation({ status: next, level });
  }, []);
  const handleTranscript = useCallback(() => setDictated(true), []);

  // A voice turn ends when the reply does
  const [wasActive, setWasActive] = useState(isActive);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    if (!isActive) setVoiceTurn(false);
  }

  const handleSubmit = useCallback(
    (message: { text: string; files: FileUIPart[] }) => {
      if (dictated) setVoiceTurn(true);
      setDictated(false);
      return onSubmit(message);
    },
    [dictated, onSubmit],
  );

  const listening = dictation.status === "listening" || dictation.status === "starting";
  const processing = dictation.status === "transcribing" || (voiceTurn && isActive);
  const level = dictation.level;
  const readLevel = useCallback(() => (listening && level ? level.get() : 0), [listening, level]);
  // The glow clips to the composer, which would also cut off its shadow and
  // focus ring — so clip only while the glow is on screen (until it has faded out)
  const glowOn = listening || processing;
  const [glowShown, setGlowShown] = useState(false);
  if (glowOn && !glowShown) setGlowShown(true);
  const handleGlowGone = useCallback(() => setGlowShown(false), []);

  const handleError = useCallback(
    (err: { code: string; message: string }) => toast.error(err.message),
    [],
  );

  return (
    <div
      className="relative shrink-0 pb-3 pt-2"
    >
      <div className={`${maxWidth} mx-auto w-full px-4 sm:px-6`}>
        {/* Provider lifts the text so dictation can write into the composer */}
        <PromptInputProvider>
        <VoiceBeam
          active={glowOn}
          level={readLevel}
          processing={processing}
          borderRadius={28}
          theme={resolvedTheme === "light" ? "light" : "dark"}
          onDeactivate={handleGlowGone}
          style={glowShown ? undefined : { overflow: "visible" }}
        >
        <PromptInput
          className="prompt-input"
          maxFileSize={5 * 1024 * 1024}
          maxFiles={5}
          multiple
          onError={handleError}
          onSubmit={handleSubmit}
        >
          <AttachmentPreviewList />
          <PromptInputTextarea placeholder={placeholder} />
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger tooltip="Add files or images" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              {extraTools}
            </PromptInputTools>
            <div className="flex items-center gap-1">
              <VoiceDictationButton onStatusChange={handleDictationStatus} onTranscript={handleTranscript} />
              {onVoiceMode && (
                <PromptInputButton
                  tooltip="Voice conversation"
                  aria-label="Start voice conversation"
                  onClick={() => {
                    // Unlock audio inside the tap, before the session starts (iPad)
                    unlockAudio();
                    onVoiceMode();
                  }}
                >
                  <HugeiconsIcon icon={AudioWave01Icon} size={16} />
                </PromptInputButton>
              )}
              <PromptInputSubmit
                status={status}
                onStop={onStop}
                disabled={isActive && status !== "streaming"}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
        </VoiceBeam>
        </PromptInputProvider>
      </div>
    </div>
  );
}
