"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationFrame, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { ChatStatus } from "ai";
import useSWR from "swr";
import { useTheme } from "next-themes";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { VoiceBeam } from "voice-glow";
import { HugeiconsIcon, Cancel01Icon, Mic01Icon, MicOff01Icon, VolumeHighIcon, ViewIcon, ViewOffSlashIcon } from "@/components/icons";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useSpeechOutput } from "@/hooks/use-speech-output";
import { useLiveVoice, type LiveHistoryItem } from "@/hooks/use-live-voice";
import { VoiceTranscript } from "@/components/assistant/voice-transcript";
import { CORE_URL } from "@/lib/constants";
import { unlockAudio } from "@/lib/audio-session";
import { DesktopLink } from "@/components/desktop/desktop-link";
import { IconSwap } from "@/components/ui/micro";
import { Button } from "@/components/ui/button";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { cn } from "@/lib/utils";
import { DURATION, TRAVEL, enter, exit } from "@/lib/motion";

export interface LastAssistant {
  id: string;
  text: string;
  /** Name of a tool waiting for the user's approval, if any */
  pendingApproval?: string;
}

export interface VoiceModeProps {
  open: boolean;
  onClose: () => void;
  /** Send a transcribed message to the assistant */
  onSend: (text: string) => void;
  status: ChatStatus;
  /** Latest assistant message, to read aloud when a reply finishes */
  lastAssistant: LastAssistant | null;
  /** Recent conversation, for full-duplex sessions that start mid-chat */
  history?: () => LiveHistoryItem[];
}

interface VoiceStatus {
  live: { model: string; voice: string } | null;
}

/**
 * Voice conversation. With an OpenAI key, Talome talks through GPT-Live — full
 * duplex, so you can interrupt and it can acknowledge while you speak. Without
 * one it falls back to listen → send after a pause → read the reply aloud.
 */
export function VoiceMode(props: VoiceModeProps) {
  const embedded = useIsEmbeddedFrame();
  const { data } = useSWR<VoiceStatus>(
    props.open ? `${CORE_URL}/api/voice/status` : null,
    (url: string) => fetch(url).then((r) => (r.ok ? r.json() : { live: null })),
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <AnimatePresence>
      {props.open && data && (
        <motion.div
          key="voice"
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
          data-window-drag-region={embedded ? "surface" : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: enter(DURATION.base) }}
          exit={{ opacity: 0, transition: exit() }}
          className={cn("fixed inset-0 z-[1300] flex flex-col items-center justify-center gap-6 p-6 backdrop-blur-xl", embedded ? "tm-window-voice bg-card/85" : "bg-background/85")}
        >
          {data.live ? <LiveSession {...props} /> : <ClassicSession {...props} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Shared stage ─────────────────────────────────────────────────────────────

interface StageProps {
  /** Voice level 0–1, sampled every frame */
  level: () => number;
  processing: boolean;
  orb: OrbState;
  label: string;
  caption: string;
  footnote: string | null;
  orbLabel: string;
  onOrbTap?: () => void;
  onRetry?: () => void;
  onClose: () => void;
  transcript?: ReactNode;
  muted?: boolean;
  onToggleMute?: () => void;
  muteDisabled?: boolean;
  onResumePlayback?: () => void;
}

/** Share of the gap to the live voice level the orb closes each frame: smoothing, not a spring. */
const LEVEL_SMOOTHING = 0.25;
const VOICE_CONTROL = "h-12 rounded-full border-border bg-muted/30 px-4 shadow-none hover:bg-muted/60 dark:border-border dark:bg-muted/30 dark:hover:bg-muted/60 [&_svg]:size-5";

function VoiceStage({ level, processing, orb, label, caption, footnote, orbLabel, onOrbTap, onRetry, onClose, transcript, muted, onToggleMute, muteDisabled, onResumePlayback }: StageProps) {
  const [showTranscript, setShowTranscript] = useState(true);
  const reduceMotion = useReducedMotion();
  const { resolvedTheme } = useTheme();
  // The orb swells with the voice level, eased toward it frame by frame. It
  // tracks live data, so it is not a spring (CLAUDE.md: DRAG_SETTLE_SPRING only)
  // and it stays still under reduced motion.
  const smoothed = useMotionValue(0);
  useAnimationFrame(() => {
    if (reduceMotion) {
      if (smoothed.get() !== 0) smoothed.set(0);
      return;
    }
    const current = smoothed.get();
    smoothed.set(current + (level() - current) * LEVEL_SMOOTHING);
  });
  const scale = useTransform(smoothed, (v) => (reduceMotion ? 1 : 1 + v * 0.12));

  return (
    <>
      {/* The glow rises from the bottom edge with the voice and sweeps while the reply is prepared */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <VoiceBeam
          type="mobile"
          level={level}
          processing={processing}
          theme={resolvedTheme === "light" ? "light" : "dark"}
          borderRadius={0}
          className="size-full"
        >
          <div className="size-full" />
        </VoiceBeam>
      </div>

      <button
        type="button"
        onClick={onOrbTap}
        aria-label={orbLabel}
        className={cn("relative flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-foreground/40", transcript && showTranscript ? "size-24" : "size-40")}
      >
        <motion.span style={{ scale }} className="flex">
          <ThinkingOrb state={orb} size={64} aria-hidden />
        </motion.span>
      </button>

      <div className="relative flex shrink-0 max-w-md flex-col items-center gap-2 text-center">
        {/* Status swaps in place: the old line lifts away as the new one rises */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            key={label}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: TRAVEL.lift, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: reduceMotion ? { duration: DURATION.exitFast } : enter(DURATION.fast) }}
            exit={reduceMotion ? { opacity: 0, transition: { duration: DURATION.exitFast } } : { opacity: 0, y: -TRAVEL.lift, filter: "blur(2px)", transition: exit(DURATION.exitFast) }}
            className="text-lg font-medium"
            aria-live="polite"
          >
            {label}
          </motion.p>
        </AnimatePresence>
        <p className="text-sm text-muted-foreground">{caption}</p>
        {onRetry && <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={onRetry}>Try microphone again</Button>
          <Button variant="ghost" asChild><DesktopLink href="/dashboard/settings/voice-diagnostics">Voice diagnostics</DesktopLink></Button>
        </div>}
      </div>

      {transcript && showTranscript && transcript}

      <div className="relative flex shrink-0 flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-3">
          {onToggleMute && <Button variant="outline" className={cn(VOICE_CONTROL, "min-w-32", muted && "bg-muted dark:bg-muted")} disabled={muteDisabled} aria-pressed={muted} onClick={onToggleMute}>
            <IconSwap active={muted ? "b" : "a"} a={<HugeiconsIcon icon={Mic01Icon} size={20} />} b={<HugeiconsIcon icon={MicOff01Icon} size={20} />} />
            {muted ? "Unmute mic" : "Mute mic"}
          </Button>}
          {transcript && <Button variant="outline" className={cn(VOICE_CONTROL, "min-w-40")} aria-pressed={showTranscript} onClick={() => setShowTranscript((shown) => !shown)}>
            <IconSwap active={showTranscript ? "a" : "b"} a={<HugeiconsIcon icon={ViewOffSlashIcon} size={20} />} b={<HugeiconsIcon icon={ViewIcon} size={20} />} />
            {showTranscript ? "Hide transcript" : "Show transcript"}
          </Button>}

          {onResumePlayback && <Button variant="outline" className={VOICE_CONTROL} onClick={onResumePlayback}>
            <HugeiconsIcon icon={VolumeHighIcon} size={20} /> Enable audio
          </Button>}
          <Button variant="outline" className={VOICE_CONTROL} onClick={onClose} aria-label="End voice conversation">
            <HugeiconsIcon icon={Cancel01Icon} size={20} /> End
          </Button>
        </div>
        {/* A quiet hint: where the voice goes, or why voice is unavailable */}
        {footnote && <p className="text-xs text-dim-foreground">{footnote}</p>}
      </div>
    </>
  );
}

// ── Ask Talome and wait for the reply ────────────────────────────────────────

/** Sends through the chat and resolves when that reply is complete. */
function useChatReply({ onSend, status, lastAssistant }: Pick<VoiceModeProps, "onSend" | "status" | "lastAssistant">) {
  const pending = useRef<{ resolve: (text: string) => void; after: string | null; sawBusy: boolean } | null>(null);

  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (status === "submitted" || status === "streaming") {
      p.sawBusy = true;
      return;
    }
    if (!p.sawBusy) return;
    pending.current = null;
    if (status === "error") {
      p.resolve("Talome ran into an error with that. It's shown in the chat.");
    } else if (lastAssistant?.pendingApproval) {
      p.resolve(`Talome needs the user's approval on screen to run ${lastAssistant.pendingApproval}.`);
    } else if (lastAssistant && lastAssistant.id !== p.after) {
      p.resolve(lastAssistant.text);
    } else {
      p.resolve("Talome didn't answer that. Say so briefly and suggest checking the chat.");
    }
  }, [status, lastAssistant]);

  const lastId = lastAssistant?.id ?? null;
  return useCallback(
    (text: string) =>
      new Promise<string>((resolve) => {
        pending.current?.resolve("");
        pending.current = { resolve, after: lastId, sawBusy: false };
        onSend(text);
      }),
    [onSend, lastId],
  );
}

// ── GPT-Live: full duplex ────────────────────────────────────────────────────

const LIVE_ORB: Record<string, OrbState> = { listening: "listening", speaking: "composing", working: "working" };
const LIVE_LABEL: Record<string, string> = { listening: "Listening", speaking: "Talome", working: "Working on it" };

function LiveSession({ onClose, onSend, status, lastAssistant, history }: VoiceModeProps) {
  const ask = useChatReply({ onSend, status, lastAssistant });
  const live = useLiveVoice({ onDelegate: ask, history });
  const { start, stop } = live;

  useEffect(() => {
    void start();
    return () => stop();
  }, [start, stop]);

  const speaking = live.activity === "speaking";
  const { agentLevel, userLevel } = live;
  const level = useCallback(() => (speaking ? agentLevel.get() : userLevel.get()), [speaking, agentLevel, userLevel]);
  const label = live.state === "connecting" ? "Connecting…" : live.error || live.state === "ended" ? "Voice ended" : live.muted && live.activity === "listening" ? "Microphone muted" : LIVE_LABEL[live.activity];
  const caption = live.error
    ?? (live.playbackBlocked ? "Audio playback is paused. Tap Enable audio to hear Talome." : null)
    ?? (live.state === "live" ? "Just talk — interrupt any time." : "");
  const retry = () => {
    unlockAudio();
    stop();
    void start();
  };

  return (
    <VoiceStage
      level={level}
      processing={live.state === "connecting" || live.activity === "working"}
      orb={live.state === "connecting" ? "connecting" : LIVE_ORB[live.activity]}
      label={label}
      caption={caption}
      // Where the voice goes, in plain words (no protocol or model id)
      footnote="Voice by OpenAI"
      transcript={<VoiceTranscript entries={live.transcript ?? []} />}
      muted={live.muted}
      onToggleMute={live.toggleMute}
      muteDisabled={live.state !== "live"}
      onResumePlayback={live.playbackBlocked ? live.resumePlayback : undefined}
      orbLabel={live.error ? "Try microphone again" : "End voice conversation"}
      onOrbTap={live.error ? retry : onClose}
      onRetry={live.error ? retry : undefined}
      onClose={onClose}
    />
  );
}

// ── Fallback: turn by turn ───────────────────────────────────────────────────

type Phase = "listening" | "transcribing" | "thinking" | "speaking";

const PHASE_ORB: Record<Phase, OrbState> = {
  listening: "listening",
  transcribing: "solving",
  thinking: "working",
  speaking: "composing",
};

const PHASE_LABEL: Record<Phase, string> = {
  listening: "Listening",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking",
};

function ClassicSession({ onClose, onSend, status, lastAssistant }: VoiceModeProps) {
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
  const { engine, start, cancel } = voice;
  const cancelSpeech = speech.cancel;

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

  // Start listening when shown; stop everything when closed
  useEffect(() => {
    if (!engine) return;
    setTranscript("");
    setPhase("listening");
    void start();
    return () => {
      cancel();
      cancelSpeech();
      awaitingReplyAfter.current = undefined;
    };
  }, [engine, start, cancel, cancelSpeech]);

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
      void speech.speak(lastAssistant.text).then(() => void listen());
    }
  }, [phase, status, lastAssistant, speech, listen]);

  const retry = () => {
    unlockAudio();
    cancel();
    cancelSpeech();
    void listen();
  };
  const tapOrb = () => {
    if (voice.error) retry();
    else if (phase === "listening") void finishListening();
    else if (phase === "speaking") {
      speech.cancel();
      void listen();
    }
  };

  const micLevel = voice.level;
  const level = useCallback(() => (phase === "speaking" ? speechPulse.get() : micLevel.get()), [phase, speechPulse, micLevel]);

  return (
    <VoiceStage
      level={level}
      processing={phase === "transcribing" || phase === "thinking"}
      orb={PHASE_ORB[phase]}
      label={voice.error ? "Microphone unavailable" : !engine ? "Voice unavailable" : voice.status === "starting" ? "Starting microphone…" : PHASE_LABEL[phase]}
      caption={voice.error || transcript || (engine && phase === "listening" ? "Say something — I'll answer when you pause." : "")}
      footnote={
        voice.engine === "browser"
          ? "Using this browser's speech recognition"
          : voice.engine === "server"
            ? "Transcribed by your Talome server"
            : voice.unavailableReason
      }
      orbLabel={voice.error ? "Try microphone again" : phase === "speaking" ? "Stop speaking" : phase === "listening" ? "Send now" : PHASE_LABEL[phase]}
      onOrbTap={tapOrb}
      onRetry={voice.error ? retry : undefined}
      onClose={onClose}
    />
  );
}
