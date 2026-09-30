"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Turn assistant markdown into something pleasant to hear. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read replies aloud with the device's speech synthesis (on-device on most
 * platforms). `boundary` pulses on each spoken word so visuals can follow speech.
 */
export function useSpeechOutput(onBoundary?: () => void) {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const boundaryRef = useRef(onBoundary);
  useEffect(() => {
    boundaryRef.current = onBoundary;
  });

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback((markdown: string) => new Promise<void>((resolve) => {
    const text = speakableText(markdown);
    if (!supported || !text) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-US";
    utterance.onboundary = () => boundaryRef.current?.();
    utterance.onend = () => {
      setSpeaking(false);
      resolve();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      resolve();
    };
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }), [supported]);

  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  return { supported, speaking, speak, cancel };
}
