"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon, ViewIcon, ViewOffSlashIcon, AlertCircleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopText } from "@/components/ui/micro";
import { CSS_EASE_ENTER, DURATION, DURATION_MS, TRAVEL, enter as enterTransition, exit as exitTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { DEFAULT_SIGN_IN_WALLPAPER, readStoredWallpaper } from "@/lib/wallpaper";

/** Talome's mark at full contrast (sign-in and setup). */
function TalomeMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="text-foreground">
      <circle cx="12" cy="4.5" r="1.7" /><circle cx="17.1" cy="7" r="1.27" opacity="0.56" /><circle cx="12" cy="9.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="12" r="1.27" opacity="0.56" /><circle cx="12" cy="14.5" r="1.7" /><circle cx="17.5" cy="17" r="1.27" opacity="0.56" /><circle cx="12" cy="19.5" r="0.72" opacity="0.12" /><circle cx="12" cy="4.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="7" r="1.27" opacity="0.56" /><circle cx="12" cy="9.5" r="1.7" /><circle cx="17.5" cy="12" r="1.27" opacity="0.56" /><circle cx="12" cy="14.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="17" r="1.27" opacity="0.56" /><circle cx="12" cy="19.5" r="1.7" />
    </svg>
  );
}

/** A labelled field: label above the input, optional hint, error linked with aria-describedby. */
export const AuthField = forwardRef<
  HTMLInputElement,
  Omit<ComponentProps<typeof Input>, "id"> & {
    label: string;
    hint?: string;
    error?: string | null;
    /** Adds a show/hide toggle (aria-pressed) for passwords. */
    revealable?: boolean;
  }
>(function AuthField({ label, hint, error, revealable = false, type, className, ...props }, ref) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // A new error moves focus to its field, so a keyboard or screen-reader user
  // who pressed submit lands where the fix is (the message is also announced).
  const hasError = Boolean(error);
  useEffect(() => {
    if (hasError) inputRef.current?.focus();
  }, [hasError]);
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const inputType = revealable ? (revealed ? "text" : "password") : type;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          ref={setRefs}
          id={id}
          type={inputType}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn("h-10", revealable && "pr-11", className)}
          {...props}
        />
        {revealable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Show password"
            aria-pressed={revealed}
            title={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((value) => !value)}
            className="absolute top-1 right-1 pointer-coarse:size-11 pointer-coarse:top-0 pointer-coarse:right-0"
          >
            <HugeiconsIcon icon={revealed ? ViewOffSlashIcon : ViewIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-status-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/** A form-level error: role=alert, names the fix. */
export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-status-critical">
      <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** A text-link button with the designed focus ring. */
export function AuthLink({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-sm text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    />
  );
}

// ── Sign-in frame ────────────────────────────────────────────────────────────

/**
 * The frame shared by /login and /setup: the device's desktop wallpaper behind
 * a lock-screen clock and a glass card holding the brand mark, one h1, a
 * subtitle and the form. On sign-in the card shakes when an attempt is
 * refused, and lifts away as you sign in. Glass falls back to a solid surface
 * under reduced transparency (globals.css), and the shake / lift are skipped
 * under reduced motion.
 */
export function SignInFrame({
  title,
  titleKey = title,
  subtitle,
  children,
  footer = "Your data stays on your server.",
  unlocking = false,
  shakeClassName,
}: {
  title: string;
  /** Changes when the view changes, so the heading cross-fades (defaults to the title). */
  titleKey?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Signed in: the card lifts away and the wallpaper eases forward. */
  unlocking?: boolean;
  shakeClassName?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background p-6">
      <SignInBackdrop unlocking={unlocking} />

      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: TRAVEL.lift }}
        animate={
          unlocking && !reduceMotion
            ? { opacity: 0, y: -TRAVEL.lift, scale: 1.02, filter: "blur(4px)" }
            : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
        }
        transition={unlocking ? exitTransition() : enterTransition()}
        className="relative z-10 flex w-full max-w-sm flex-col items-center"
      >
        <LockClock />

        <div className={`tm-glass-dense w-full rounded-2xl border p-6 ${shakeClassName ?? ""}`}>
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-foreground/[0.06]">
              <TalomeMark />
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.h1
                key={titleKey}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: TRAVEL.rise }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -TRAVEL.rise }}
                transition={enterTransition(DURATION.fast)}
                className="text-2xl font-medium tracking-tight text-foreground"
              >
                {title}
              </motion.h1>
            </AnimatePresence>
            {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          {children}
        </div>

        {footer ? <p className="tm-on-scrim mt-6 text-center text-sm text-foreground/80">{footer}</p> : null}
      </motion.div>
    </main>
  );
}

/**
 * The desktop wallpaper chosen on this device fills the screen behind sign-in,
 * under a flat scrim so the form stays legible on any image.
 */
function subscribeToWallpaper(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function SignInBackdrop({ unlocking }: { unlocking: boolean }) {
  const stored = useSyncExternalStore(subscribeToWallpaper, () => readStoredWallpaper() ?? DEFAULT_SIGN_IN_WALLPAPER, () => null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const reduceMotion = useReducedMotion();

  if (!stored) return null;
  const url = failed ? DEFAULT_SIGN_IN_WALLPAPER : stored;
  const ease = `var(--ease-enter, ${CSS_EASE_ENTER})`;
  return (
    <div className="absolute inset-0" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- local, data: or remote wallpaper URLs */}
      <img
        src={url}
        alt=""
        onLoad={() => setLoaded(true)}
        onError={() => { if (url !== DEFAULT_SIGN_IN_WALLPAPER) setFailed(true); }}
        className="absolute inset-0 size-full object-cover"
        style={{
          opacity: loaded ? 1 : 0,
          transform: reduceMotion ? "scale(1)" : unlocking ? "scale(1.04)" : loaded ? "scale(1)" : "scale(1.03)",
          transition: reduceMotion
            ? `opacity ${DURATION_MS.fast}ms ${ease}`
            : unlocking
              ? `transform ${DURATION_MS.sheet}ms ${ease}`
              : `opacity ${DURATION_MS.base}ms ${ease}, transform ${DURATION_MS.base}ms ${ease}`,
        }}
      />
      {/* The scrim lifts as you sign in, so the desktop seems to come forward */}
      <div
        className={`absolute inset-0 bg-background/45 transition-opacity duration-[var(--duration-base)] ${unlocking ? "opacity-0" : ""}`}
      />
    </div>
  );
}

/** Time and date above the sign-in card, like a lock screen. */
function subscribeToClock(onTick: () => void) {
  const timer = setInterval(onTick, 10_000);
  const onVisible = () => { if (document.visibilityState === "visible") onTick(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Current time, rounded to the minute so the snapshot is stable between ticks. */
function clockSnapshot(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function LockClock() {
  const minute = useSyncExternalStore(subscribeToClock, clockSnapshot, () => null);

  if (minute === null) return <div className="mb-6 h-16" />;
  const now = new Date(minute);
  return (
    <div className="tm-on-scrim mb-6 select-none text-center">
      <p className="text-2xl font-medium tabular-nums text-foreground">
        <PopText value={now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} />
      </p>
      <p className="mt-1 text-sm text-foreground/80">
        {now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
      </p>
    </div>
  );
}
