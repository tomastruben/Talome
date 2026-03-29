"use client";

import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  HugeiconsIcon,
  AiChipIcon,
  ArrowRight01Icon,
  Film01Icon,
  Home01Icon,
  Shield01Icon,
  ComputerTerminal01Icon,
  AiChat02Icon,
  CheckmarkCircle01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useSetupStatus, type SetupPhase } from "@/hooks/use-setup-status";
import type { IconSvgElement } from "@/components/icons";

const DISMISS_KEY = "talome-welcome-dismissed";
const OPERATIONAL_DISMISS_KEY = "talome-welcome-operational-dismissed";

// ── Suggestion chips — each opens the assistant with a focused prompt ────────

const SUGGESTIONS: { label: string; icon: IconSvgElement; prompt: string }[] = [
  {
    label: "Media server",
    icon: Film01Icon,
    prompt: "I want to stream movies and TV shows on my home network. Set up a complete media server for me.",
  },
  {
    label: "Smart home",
    icon: Home01Icon,
    prompt: "Set up smart home automation for me with Home Assistant and network-level ad blocking.",
  },
  {
    label: "Privacy tools",
    icon: Shield01Icon,
    prompt: "I want a private, self-hosted setup — password manager, ad blocking, and secure DNS.",
  },
  {
    label: "Dev tools",
    icon: ComputerTerminal01Icon,
    prompt: "Set up developer tools for me — Git hosting, CI, and monitoring.",
  },
];

// ── Phases that show the welcome card ────────────────────────────────────────

const VISIBLE_PHASES: SetupPhase[] = ["ai-pending", "exploring", "building", "operational"];

// ── Welcome Card ─────────────────────────────────────────────────────────────

export function WelcomeCard() {
  const {
    isLoaded, isConfigured, phase, previewState,
    nearestStack, completeStackCount,
  } = useSetupStatus();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dismissed, setDismissed] = useState(true);
  const [visible, setVisible] = useState(true);
  const [input, setInput] = useState("");

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === "true");
  }, []);

  // Auto-dismiss operational phase after 3 days
  useEffect(() => {
    if (phase !== "operational") return;
    const ts = localStorage.getItem(OPERATIONAL_DISMISS_KEY);
    if (ts) {
      const elapsed = Date.now() - Number(ts);
      if (elapsed > 3 * 24 * 60 * 60 * 1000) {
        localStorage.setItem(DISMISS_KEY, "true");
        setDismissed(true);
      }
    } else {
      localStorage.setItem(OPERATIONAL_DISMISS_KEY, String(Date.now()));
    }
  }, [phase]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      localStorage.setItem(DISMISS_KEY, "true");
      setDismissed(true);
    }, 200);
  }, []);

  const goToAssistant = useCallback(
    (prompt: string) => {
      if (previewState) return;
      router.push(
        `/dashboard/assistant?prompt=${encodeURIComponent(prompt)}`
      );
    },
    [router, previewState]
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (trimmed) goToAssistant(trimmed);
    },
    [input, goToAssistant]
  );

  if (!isLoaded) return null;

  // Hide for growing phase (fully set up) unless previewing
  if (!previewState && !VISIBLE_PHASES.includes(phase)) return null;

  // User dismissed (unless previewing)
  if (!previewState && dismissed) return null;

  // ── Progress steps ──────────────────────────────────────────────────────
  const steps = [
    { label: "Connect AI", done: isConfigured },
    { label: "Set up a stack", done: phase === "building" || phase === "operational" || phase === "growing" },
    { label: "You\u2019re running", done: phase === "operational" || phase === "growing" },
  ];
  const stepIndex = steps.findIndex(s => !s.done);

  return (
    <div
      className="overflow-hidden transition-all duration-200 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        maxHeight: visible ? 700 : 0,
      }}
    >
      {/* ── Progress bar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-3 pt-8 pb-2 max-w-xs mx-auto">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-3 flex-1 last:flex-initial">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`size-5 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 transition-colors duration-200 ${
                  s.done
                    ? "bg-status-healthy/20 text-status-healthy"
                    : i === stepIndex
                      ? "bg-foreground/10 text-muted-foreground"
                      : "bg-muted/50 text-muted-foreground"
                }`}
              >
                {s.done ? "\u2713" : i + 1}
              </div>
              <span
                className={`text-xs truncate transition-colors duration-200 ${
                  s.done
                    ? "text-status-healthy/70"
                    : i === stepIndex
                      ? "text-muted-foreground"
                      : "text-muted-foreground"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`h-px flex-1 min-w-3 transition-colors duration-200 ${s.done ? "bg-status-healthy/20" : "bg-border/30"}`} />
            )}
          </div>
        ))}
      </div>

      {phase === "ai-pending" ? (
        /* ── Phase: AI not configured ──────────────────────────────────── */
        <div className="flex flex-col items-center text-center py-10 sm:py-12 max-w-md mx-auto">
          <HugeiconsIcon
            icon={AiChipIcon}
            size={28}
            className="text-dim-foreground mb-5"
            strokeWidth={1.5}
          />
          <h2 className="text-lg font-medium text-foreground mb-2">
            Connect an AI provider to get started
          </h2>
          <p className="text-sm text-muted-foreground mb-8 max-w-xs">
            Talome uses AI to help you install, configure, and manage everything on your server.
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/settings/ai-provider">
              Set up provider
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </Link>
          </Button>
        </div>
      ) : phase === "exploring" ? (
        /* ── Phase: AI configured, no apps yet ─────────────────────────── */
        <div className="flex flex-col items-center text-center py-10 sm:py-14 max-w-lg mx-auto px-4">
          <h2 className="text-lg font-medium text-foreground mb-6">
            What should your server do?
          </h2>

          <form onSubmit={handleSubmit} className="w-full max-w-sm mb-6">
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Stream movies, block ads, host files..."
                className="w-full rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-border focus:bg-muted/30 transition-colors"
              />
              {input.trim() && (
                <button
                  type="submit"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-foreground/10 p-1.5 text-muted-foreground hover:bg-foreground/15 hover:text-foreground transition-colors"
                >
                  <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
                </button>
              )}
            </div>
          </form>

          <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
            <span className="text-xs text-muted-foreground mr-1">Or try</span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => goToAssistant(s.prompt)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-foreground/[0.03] px-3 py-1.5 text-xs text-muted-foreground hover:border-border/60 hover:bg-foreground/[0.06] hover:text-foreground transition-all duration-150"
              >
                <HugeiconsIcon icon={s.icon} size={12} className="text-dim-foreground" />
                {s.label}
              </button>
            ))}
          </div>

          <button
            onClick={dismiss}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            I'll explore on my own
          </button>
        </div>
      ) : phase === "building" && nearestStack ? (
        /* ── Phase: Apps installed, stack incomplete ────────────────────── */
        <div className="flex flex-col items-center text-center py-10 sm:py-12 max-w-md mx-auto px-4">
          <h2 className="text-lg font-medium text-foreground mb-2">
            Your {nearestStack.name.toLowerCase()} is {Math.round(nearestStack.readiness * 100)}% ready
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {nearestStack.deps.filter(d => d.status !== "configured").length} service{nearestStack.deps.filter(d => d.status !== "configured").length !== 1 ? "s" : ""} still need{nearestStack.deps.filter(d => d.status !== "configured").length === 1 ? "s" : ""} configuring.
          </p>

          {/* Mini progress bar */}
          <div className="w-full max-w-xs h-1 bg-muted/30 rounded-full mb-6 overflow-hidden">
            <div
              className="h-full bg-status-healthy rounded-full transition-all duration-500"
              style={{ width: `${Math.round(nearestStack.readiness * 100)}%` }}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(nearestStack.dashboardPage)}
            >
              Continue setup
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const missing = nearestStack.deps
                  .filter(d => d.status !== "configured")
                  .map(d => d.label);
                goToAssistant(
                  `Help me finish setting up my ${nearestStack.name.toLowerCase()}. I still need: ${missing.join(", ")}.`
                );
              }}
            >
              <HugeiconsIcon icon={AiChat02Icon} size={14} />
              Set up with AI
            </Button>
          </div>

          <button
            onClick={dismiss}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-6"
          >
            Dismiss
          </button>
        </div>
      ) : phase === "operational" ? (
        /* ── Phase: At least one stack fully configured ─────────────────── */
        <div className="flex flex-col items-center text-center py-8 sm:py-10 max-w-md mx-auto px-4">
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            size={24}
            className="text-status-healthy mb-4"
            strokeWidth={1.5}
          />
          <h2 className="text-lg font-medium text-foreground mb-2">
            Your server is running
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {completeStackCount} stack{completeStackCount !== 1 ? "s" : ""} configured.{" "}
            <Link href="/dashboard/settings/security" className="text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors">
              Review security settings
            </Link>
          </p>
          <button
            onClick={dismiss}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Got it
          </button>
        </div>
      ) : (
        /* ── Fallback: building phase without nearestStack data ─────────── */
        <div className="flex flex-col items-center text-center py-10 sm:py-14 max-w-lg mx-auto px-4">
          <h2 className="text-lg font-medium text-foreground mb-6">
            What should your server do?
          </h2>
          <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => goToAssistant(s.prompt)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-foreground/[0.03] px-3 py-1.5 text-xs text-muted-foreground hover:border-border/60 hover:bg-foreground/[0.06] hover:text-foreground transition-all duration-150"
              >
                <HugeiconsIcon icon={s.icon} size={12} className="text-dim-foreground" />
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={dismiss}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
