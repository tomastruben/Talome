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
  type Ref,
} from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { HugeiconsIcon, ViewIcon, ViewOffSlashIcon, AlertCircleIcon, ArrowRight02Icon } from "@/components/icons";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopText } from "@/components/ui/micro";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CSS_EASE_ENTER,
  DURATION,
  DURATION_MS,
  SKELETON_DELAY_MS,
  TRAVEL,
  enter as enterTransition,
  exit as exitTransition,
} from "@/lib/motion";
import { userInitial } from "@/lib/sign-in";
import { cn } from "@/lib/utils";
import { overrideThemeColor } from "@/lib/theme-color";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { DEFAULT_SIGN_IN_WALLPAPER, readStoredWallpaper } from "@/lib/wallpaper";

/** Talome's mark at full contrast (sign-in and setup). */
function TalomeMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="text-foreground">
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
          <RevealToggle
            revealed={revealed}
            onToggle={() => setRevealed((value) => !value)}
            className="absolute top-1 right-1 pointer-coarse:size-11 pointer-coarse:top-0 pointer-coarse:right-0"
          />
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

/** Show/hide for a password: one name, the state in aria-pressed. */
function RevealToggle({ revealed, onToggle, className }: { revealed: boolean; onToggle: () => void; className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Show password"
      aria-pressed={revealed}
      title={revealed ? "Hide password" : "Show password"}
      onClick={onToggle}
      className={className}
    >
      <HugeiconsIcon icon={revealed ? ViewOffSlashIcon : ViewIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
    </Button>
  );
}

/**
 * A form-level error: role=alert, names the fix. On the lock screen
 * (`onScrim`) it sits straight on the wallpaper, so the text takes the
 * foreground colour and the scrim halo for contrast, and the icon carries
 * the critical colour (never the only signal: the words and the shake do too).
 */
export function AuthError({
  message,
  id,
  onScrim = false,
  className,
}: {
  message: string | null;
  id?: string;
  onScrim?: boolean;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className={cn(
        "flex items-start gap-2 text-sm",
        onScrim ? "tm-on-scrim justify-center text-center text-foreground" : "text-status-critical",
        className,
      )}
    >
      {/* On the lock screen the words and the shake carry the error; an icon
          beside centred text only pulled the line off-centre */}
      {onScrim ? null : (
        <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      )}
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

// ── Lock screen pieces (sign-in) ─────────────────────────────────────────────

/**
 * Who is signing in: their initial on a round of glass, or Talome's mark when
 * this browser doesn't know who's there. Decorative: the name is text below.
 */
export function LockAvatar({ name }: { name: string | null }) {
  return (
    <div aria-hidden="true" className="tm-glass-dense flex size-16 shrink-0 select-none items-center justify-center rounded-full border">
      {name ? <span className="text-2xl font-medium text-foreground">{userInitial(name)}</span> : <TalomeMark size={28} />}
    </div>
  );
}

/**
 * The lock screen's input: a pill of the regular glass (muted placeholder and
 * typed text keep 4.5:1 over any wallpaper), with a visually hidden label and
 * optional trailing buttons inside its right end. The glass is a layer of its
 * own so the pill can carry the designed focus ring (the material's shadow
 * would hide a ring set on the glass itself).
 *
 * The trailing buttons show once the field has text, or when one of them has
 * keyboard focus. That is decided in CSS (`:placeholder-shown`), not from
 * React state, so a password a password manager filled in shows its arrow even
 * before the browser hands the value to the page.
 */
export const LockField = forwardRef<
  HTMLInputElement,
  Omit<ComponentProps<"input">, "id" | "className"> & {
    label: string;
    trailing?: ReactNode;
    invalid?: boolean;
    describedBy?: string;
  }
>(function LockField({ label, trailing, invalid, describedBy, ...props }, ref) {
  const id = useId();
  return (
    <div
      data-lock-field=""
      // The focus ring hugs the pill: an offset would draw a band of page
      // colour between the glass and the ring over the photo.
      className="relative flex h-11 w-full items-center rounded-full has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring"
    >
      <span aria-hidden="true" className="tm-glass-dense pointer-events-none absolute inset-0 rounded-full border" />
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        // 16px on phones so iOS doesn't zoom into the field; 14px from md up.
        className={cn(
          "peer relative h-full min-w-0 flex-1 rounded-full bg-transparent pl-4 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm",
          trailing ? "pr-2" : "pr-4",
        )}
        {...props}
      />
      {/* On touch each button's hit area grows to 44px; the wider gap keeps them apart */}
      {trailing ? (
        <div className="relative flex shrink-0 items-center gap-1 pr-1.5 transition-opacity duration-150 pointer-coarse:gap-3 peer-placeholder-shown:not-focus-within:pointer-events-none peer-placeholder-shown:not-focus-within:opacity-0">
          {trailing}
        </div>
      ) : null}
    </div>
  );
});

/** Show/hide inside a lock field, offered once there is something to show. */
export function LockRevealToggle({ revealed, onToggle }: { revealed: boolean; onToggle: () => void }) {
  return (
    <RevealToggle
      revealed={revealed}
      onToggle={onToggle}
      className="relative rounded-full text-muted-foreground hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5"
    />
  );
}

/**
 * The arrow at the end of the password pill: submits the form. Never
 * disabled, so Enter always submits (a disabled default button would swallow
 * the first Enter after autofill); the page says what's missing instead.
 * It shows once there is a password (LockField). 32px to see; 44px to hit on
 * touch.
 */
export function LockSubmit({
  label,
  busy,
  busyLabel,
}: {
  label: string;
  busy: boolean;
  busyLabel: string;
}) {
  return (
    <Button
      type="submit"
      variant="ghost"
      size="icon-sm"
      busy={busy}
      busyLabel={busyLabel}
      className="relative rounded-full bg-foreground/10 text-foreground hover:bg-foreground/15 dark:hover:bg-foreground/15 pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5"
    >
      <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

/** A quiet text link set on the wallpaper (Forgot password?, switch user). */
export function LockLink({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "tm-on-scrim inline-flex min-h-6 max-w-full items-center rounded-sm px-1 text-xs text-foreground underline-offset-4 transition-colors duration-150 hover:underline pointer-coarse:min-h-11",
        FOCUS_RING,
        className,
      )}
      {...props}
    />
  );
}

/** A pill button of the same glass as the fields (Retry on the lock screen). */
export function LockButton({ className, children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "pressable group relative inline-flex h-11 items-center justify-center rounded-full px-6 text-sm font-medium text-foreground",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="tm-glass-dense pointer-events-none absolute inset-0 rounded-full border" />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full bg-foreground/5 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      <span className="relative">{children}</span>
    </button>
  );
}

/**
 * Shown while the server is being asked whether an account exists. Nothing
 * for the first 200ms (the answer is usually back by then), then quiet shapes
 * of the screen that is coming: the avatar, the name, the pill(s).
 */
export function LockPlaceholder({ knownUser }: { knownUser: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="flex w-full flex-col items-center">
      <p role="status" className="sr-only">
        Checking your server…
      </p>
      {visible ? (
        <div aria-hidden="true" className="flex w-full flex-col items-center">
          <Skeleton className="size-16 rounded-full bg-foreground/10" />
          {knownUser ? (
            <>
              <Skeleton className="mt-3 h-6 w-24 bg-foreground/10" />
              <Skeleton className="mt-4 h-11 w-full rounded-full bg-foreground/10" />
            </>
          ) : (
            <>
              <Skeleton className="mt-4 h-11 w-full rounded-full bg-foreground/10" />
              <Skeleton className="mt-2 h-11 w-full rounded-full bg-foreground/10" />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Sign-in frame ────────────────────────────────────────────────────────────

/**
 * The frame shared by /login and /setup: this device's desktop wallpaper,
 * blurred under a scrim like a lock screen, with a large clock in the top
 * third.
 *
 * - `layout="lock"` (sign-in): no card. The h1 is for screen readers; the
 *   content (avatar, name, password pill, quiet links) sits on the wallpaper
 *   in the lower third, top-aligned in a reserved area so an error line or
 *   switching user never moves the avatar.
 * - `layout="panel"` (first-run setup, password reset, recovery code): a
 *   compact glass panel with the mark, a visible h1 and the form, which
 *   shakes as a whole when an attempt is refused.
 *
 * The clock never moves between views. Signing in (`unlocking`) lifts and
 * fades everything in front of the wallpaper (a fade only under reduced
 * motion) while the scrim fades, so the wallpaper sharpens into the desktop,
 * which shows the same image. Glass falls back to a solid surface under
 * reduced transparency (globals.css).
 */
export function SignInFrame({
  title,
  titleKey = title,
  subtitle,
  children,
  footer = null,
  unlocking = false,
  shakeClassName,
  layout = "panel",
  wallpaperUrl,
}: {
  title: string;
  /** Changes when the view changes, so the content cross-fades (defaults to the title). */
  titleKey?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Signed in: the content lifts away and the wallpaper sharpens. */
  unlocking?: boolean;
  /** The panel's shake (panel layout; on the lock screen the page shakes its pills). */
  shakeClassName?: string;
  layout?: "lock" | "panel";
  wallpaperUrl?: string;
}) {
  const reduceMotion = useReducedMotion();
  // On a phone the keyboard covers the low identity area; the frame makes room
  // for it and keeps the focused field in view (iOS won't scroll it there).
  const keyboardInset = useKeyboardInset();
  const frameRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!keyboardInset) return;
    const field = document.activeElement;
    if (field instanceof HTMLElement && frameRef.current?.contains(field)) {
      field.scrollIntoView({ block: "nearest" });
    }
  }, [keyboardInset]);
  // The status bar of a Home Screen web app matches the lock screen while it
  // shows, and the chosen theme again once the dashboard takes over.
  useEffect(() => {
    overrideThemeColor("dark");
    return () => overrideThemeColor(null);
  }, []);
  return (
    // The body is fixed and never scrolls (globals.css), so the frame is its
    // own scroller: a tall panel under the clock stays reachable on a phone.
    // Like the macOS and iOS lock screens it belongs to the wallpaper, not the
    // theme: white type and smoky glass on a dimmed photo in light and dark
    // alike (a white veil turned a dark wallpaper grey and haloed black type).
    <main
      ref={frameRef}
      className="dark relative h-dvh overflow-y-auto overscroll-contain bg-background text-foreground [color-scheme:dark] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      style={keyboardInset ? { paddingBottom: `${keyboardInset}px` } : undefined}
    >
      <SignInBackdrop unlocking={unlocking} wallpaperUrl={wallpaperUrl} />

      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: TRAVEL.lift }}
        animate={
          unlocking
            ? reduceMotion
              ? { opacity: 0 }
              : { opacity: 0, y: -TRAVEL.lift }
            // At rest the wrapper carries no filter and full opacity: either
            // would make it a backdrop root, and the glass would stop seeing
            // the wallpaper.
            : { opacity: 1, y: 0 }
        }
        transition={unlocking ? exitTransition(reduceMotion ? DURATION.exitFast : DURATION.exit) : enterTransition()}
        className="relative z-10 flex min-h-full w-full flex-col items-center px-4 pt-12 pb-8 sm:px-6"
      >
        <LockClock />

        <AnimatePresence mode="popLayout" initial={false}>
          <FrameView
            key={titleKey}
            reduceMotion={Boolean(reduceMotion)}
            // The lock view reserves room for a two-line message, so an error
            // (or switching user) never moves the avatar.
            className={layout === "lock" ? "my-auto min-h-80 max-w-xs" : "my-auto max-w-sm"}
          >
            {layout === "lock" ? (
              <>
                <h1 className="sr-only">{title}</h1>
                {subtitle ? <p className="tm-on-scrim mb-4 text-center text-sm text-foreground">{subtitle}</p> : null}
                {children}
              </>
            ) : (
              <div className={cn("tm-glass-dense w-full rounded-2xl border p-6", shakeClassName)}>
                <div className="mb-6 flex flex-col items-center text-center">
                  <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-foreground/[0.06]">
                    <TalomeMark />
                  </div>
                  <h1 className="text-2xl font-medium tracking-tight text-foreground">{title}</h1>
                  {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}
                </div>
                {children}
              </div>
            )}
          </FrameView>
        </AnimatePresence>

        {footer ? <p className="tm-on-scrim mt-6 text-center text-xs text-foreground">{footer}</p> : null}
      </motion.div>
    </main>
  );
}

/**
 * One view of the frame (sign-in, reset, error…). Views cross-fade when the
 * title key changes; the one on its way out is inert and hidden from
 * assistive tech, so focus and the reading order only ever see the new one.
 */
function FrameView({
  ref,
  reduceMotion,
  className,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  reduceMotion: boolean;
  className?: string;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      inert={!present}
      aria-hidden={present ? undefined : true}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: TRAVEL.rise }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: exitTransition(DURATION.exitFast) }}
      transition={enterTransition(DURATION.fast)}
      className={cn("flex w-full flex-col items-center pt-8", className)}
    >
      {children}
    </motion.div>
  );
}

/**
 * The desktop wallpaper chosen on this device fills the screen behind sign-in,
 * under a flat scrim so the form stays legible on any image. It is pinned to
 * the viewport (the content scrolls over it), so it covers the screen exactly
 * as the desktop's wallpaper does.
 */
function subscribeToWallpaper(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function SignInBackdrop({ unlocking, wallpaperUrl }: { unlocking: boolean; wallpaperUrl?: string }) {
  const stored = useSyncExternalStore(subscribeToWallpaper, () => readStoredWallpaper() ?? wallpaperUrl ?? DEFAULT_SIGN_IN_WALLPAPER, () => null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const reduceMotion = useReducedMotion();

  if (!stored) return null;
  const url = failed ? DEFAULT_SIGN_IN_WALLPAPER : stored;
  const ease = `var(--ease-enter, ${CSS_EASE_ENTER})`;
  return (
    <div className="fixed inset-0" aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- local, data: or remote wallpaper URLs */}
      <img
        src={url}
        alt=""
        onLoad={() => setLoaded(true)}
        onError={() => { if (url !== DEFAULT_SIGN_IN_WALLPAPER) setFailed(true); }}
        className="absolute inset-0 size-full object-cover"
        style={{
          opacity: loaded ? 1 : 0,
          // Settles at scale(1) and stays there while unlocking: the desktop
          // shows the same image at the same size, so the hand-over is seamless.
          transform: reduceMotion || loaded ? "scale(1)" : "scale(1.03)",
          transition: reduceMotion
            ? `opacity ${DURATION_MS.fast}ms ${ease}`
            : `opacity ${DURATION_MS.base}ms ${ease}, transform ${DURATION_MS.base}ms ${ease}`,
        }}
      />
      {/* The scrim blurs and dims the wallpaper like a lock screen, and lifts as
          you sign in, so the wallpaper sharpens into the desktop */}
      <div
        data-lock-scrim=""
        className={`tm-lock-backdrop absolute inset-0 bg-background/45 transition-opacity duration-[var(--duration-base)] ${unlocking ? "opacity-0" : ""}`}
      />
    </div>
  );
}

/** Time and date in the top third, like a lock screen. */
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

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

/**
 * The large time shows hours and minutes only, like a lock screen ("9:41");
 * AM/PM is dropped from the big numerals but kept in the spoken time.
 */
export function lockClockParts(date: Date): { short: string; spoken: string; date: string } {
  const parts = TIME_FORMAT.formatToParts(date);
  const short = parts
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
  return { short, spoken: TIME_FORMAT.format(date), date: DATE_FORMAT.format(date) };
}

function LockClock() {
  const minute = useSyncExternalStore(subscribeToClock, clockSnapshot, () => null);

  // The large clock is the one documented exception to the type scale
  // (CLAUDE.md, Typography): text-6xl, regular weight, tight, tabular.
  if (minute === null) {
    return (
      <div aria-hidden="true" className="invisible select-none text-center sm:mt-12">
        <p className="text-6xl font-normal tracking-tight tabular-nums">0:00</p>
        <p className="mt-2 text-sm font-medium">&nbsp;</p>
      </div>
    );
  }
  const { short, spoken, date } = lockClockParts(new Date(minute));
  return (
    <div className="tm-on-scrim select-none text-center sm:mt-12">
      <p className="text-6xl font-normal tracking-tight tabular-nums text-foreground">
        <span className="sr-only">{spoken}</span>
        <span aria-hidden="true">
          <PopText value={short} />
        </span>
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">{date}</p>
    </div>
  );
}
