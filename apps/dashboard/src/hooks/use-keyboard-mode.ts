"use client";

import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "talome_keyboard_mode";

type KeyboardMode = "virtual" | "physical";

function detectTouch(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof document !== "undefined" &&
    ("ontouchend" in document || navigator.maxTouchPoints > 0)
  );
}

function detectDefault(): KeyboardMode {
  // Any touch-capable device defaults to virtual keyboard enabled.
  // Users with an external keyboard can toggle it off via the toolbar button.
  // This is the safer default — suppressing the keyboard makes the terminal
  // completely unusable without an external keyboard.
  if (detectTouch()) return "virtual";
  return "physical";
}

function getStored(): KeyboardMode | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "virtual" || v === "physical") return v;
  return null;
}

export function useKeyboardMode() {
  // Start with server-safe defaults to avoid hydration mismatch.
  // Device detection runs in useEffect after hydration.
  const [mode, setMode] = useState<KeyboardMode>("physical");
  const [showToggle, setShowToggle] = useState(false);

  // After hydration, apply stored preference or device default + detect touch
  useEffect(() => {
    const stored = getStored();
    const detected = stored ?? detectDefault();
    setMode(detected);
    setShowToggle(detectTouch());
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((prev) => (prev === "virtual" ? "physical" : "virtual"));
  }, []);

  return {
    /** "none" suppresses virtual keyboard; "text" shows it */
    inputMode: mode === "physical" ? "none" as const : "text" as const,
    /** Current raw mode */
    mode,
    /** Toggle between virtual and physical */
    toggle,
    /** Whether to render the keyboard toggle button */
    showToggle,
  };
}
