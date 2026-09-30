"use client";

import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthError, AuthField, AuthLink } from "@/components/trust/auth-shell";
import { RecoveryCodeReveal } from "@/components/trust/recovery-code";
import { PopText, useShake } from "@/components/ui/micro";
import { useAuthStatus } from "@/hooks/use-setup-status";
import { CSS_EASE_ENTER, DURATION, DURATION_MS, TRAVEL, enter as enterTransition, exit as exitTransition } from "@/lib/motion";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { DEFAULT_SIGN_IN_WALLPAPER, readStoredWallpaper } from "@/lib/wallpaper";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

type View = "login" | "recover" | "recovery-success";

const NETWORK_ERROR = "Couldn't reach the Talome server. Check that it's running, then try again.";

interface AuthResponse {
  ok?: boolean;
  error?: unknown;
  code?: string;
  field?: string;
  newRecoveryCode?: string;
}

function messageOf(body: AuthResponse | null, fallback: string): string {
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, retry } = useAuthStatus();
  const [view, setView] = useState<View>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [shownRecoveryCode, setShownRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  // Signed in: the card lifts away and the wallpaper eases forward before the dashboard appears.
  const [unlocking, setUnlocking] = useState(false);
  const { shake, shakeClassName } = useShake();
  const passwordRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();

  const returnTo = safeRedirectPath(searchParams.get("from"));
  const noAccount = status.state === "ready" && !status.accountExists;

  // No account yet: setup lives on its own screen (and its own endpoint).
  useEffect(() => {
    if (!noAccount) return;
    const from = searchParams.get("from");
    router.replace(from ? `/setup?from=${encodeURIComponent(safeRedirectPath(from))}` : "/setup");
  }, [noAccount, router, searchParams]);

  function clearErrors() {
    if (error) setError(null);
    if (fieldError) setFieldError(null);
  }

  /** Go to the (validated) return path, after the short unlock moment. */
  function goOn() {
    setUnlocking(true);
    window.setTimeout(() => {
      router.replace(returnTo);
      router.refresh();
    }, reduceMotion ? 0 : DURATION_MS.sheet);
  }

  /** A refused attempt: say why, shake the card, and select the password to retype. */
  function reject(message: string, selectPassword: boolean) {
    setError(message);
    shake();
    if (selectPassword) requestAnimationFrame(() => passwordRef.current?.select());
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    if (loading || unlocking) return;
    if (!username.trim()) {
      setFieldError({ field: "username", message: "Enter your username." });
      shake();
      return;
    }
    setError(null);
    setFieldError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as AuthResponse | null;
      if (res.ok && data?.ok) {
        goOn();
        return;
      }
      if (data?.code === "setup_required") {
        retry();
        return;
      }
      reject(messageOf(data, "Couldn't sign in. Check your username and password, then try again."), true);
    } catch {
      reject(NETWORK_ERROR, false);
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    if (newPassword !== confirmPassword) {
      setFieldError({ field: "confirm", message: "The passwords don't match." });
      shake();
      return;
    }
    setError(null);
    setFieldError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), recoveryCode, newPassword }),
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as AuthResponse | null;
      if (res.ok && data?.ok && data.newRecoveryCode) {
        setShownRecoveryCode(data.newRecoveryCode);
        setView("recovery-success");
      } else {
        reject(messageOf(data, "Couldn't reset the password. Check the username and recovery code, then try again."), false);
      }
    } catch {
      reject(NETWORK_ERROR, false);
    } finally {
      setLoading(false);
    }
  }

  const frame = { unlocking, shakeClassName };

  if (status.state === "error") {
    return (
      <SignInFrame {...frame} titleKey="error" title="Can't reach Talome" subtitle={status.message}>
        <Button className="h-10 w-full" onClick={retry}>
          Retry
        </Button>
      </SignInFrame>
    );
  }

  if (status.state === "loading" || noAccount) {
    return (
      <SignInFrame {...frame} titleKey="loading" title="Sign in" subtitle="Checking your server…" footer={null}>
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </SignInFrame>
    );
  }

  if (view === "recovery-success") {
    return (
      <SignInFrame
        {...frame}
        titleKey="code"
        title="Save your new recovery code"
        subtitle="Your password is reset and you're signed in. The code you used no longer works."
      >
        <RecoveryCodeReveal code={shownRecoveryCode} username={username.trim()} onContinue={goOn} />
      </SignInFrame>
    );
  }

  if (view === "recover") {
    const mismatch = fieldError?.field === "confirm" ? fieldError.message : null;
    return (
      <SignInFrame {...frame} titleKey="recover" title="Reset password" subtitle="Enter your recovery code to set a new password.">
        <form onSubmit={handleRecover} className="flex flex-col gap-4" noValidate>
          <AuthField
            label="Username"
            value={username}
            onChange={(e) => { setUsername(e.target.value); clearErrors(); }}
            autoFocus
            autoComplete="username"
            required
          />
          <AuthField
            label="Recovery code"
            hint="Upper or lower case, with or without hyphens."
            value={recoveryCode}
            onChange={(e) => { setRecoveryCode(e.target.value); clearErrors(); }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono tracking-wider"
            required
          />
          <AuthField
            label="New password"
            hint="At least 8 characters."
            revealable
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); clearErrors(); }}
            autoComplete="new-password"
            required
          />
          <AuthField
            label="Confirm new password"
            revealable
            value={confirmPassword}
            error={mismatch}
            onChange={(e) => { setConfirmPassword(e.target.value); clearErrors(); }}
            autoComplete="new-password"
            required
          />
          <AuthError message={error} />
          <Button
            type="submit"
            className="h-10 w-full"
            busy={loading}
            busyLabel="Resetting password…"
            disabled={!username.trim() || !recoveryCode.trim() || newPassword.length < 8 || !confirmPassword}
          >
            Reset password
          </Button>
        </form>
        <div className="mt-6 text-center">
          <AuthLink onClick={() => { clearErrors(); setView("login"); }}>Back to sign in</AuthLink>
        </div>
      </SignInFrame>
    );
  }

  return (
    <SignInFrame {...frame} titleKey="welcome" title="Welcome back" subtitle="Sign in to your Talome server.">
      <form onSubmit={handleLogin} className="flex flex-col gap-4" noValidate>
        <AuthField
          label="Username"
          value={username}
          error={fieldError?.field === "username" ? fieldError.message : null}
          onChange={(e) => { setUsername(e.target.value); clearErrors(); }}
          autoFocus
          autoComplete="username"
          required
        />
        <AuthField
          ref={passwordRef}
          label="Password"
          revealable
          value={password}
          onChange={(e) => { setPassword(e.target.value); clearErrors(); }}
          autoComplete="current-password"
          required
        />
        <AuthError message={error} />
        <Button
          type="submit"
          className="h-10 w-full"
          busy={loading || unlocking}
          busyLabel={unlocking ? "Opening Talome…" : "Signing in…"}
          disabled={!password}
        >
          Sign in
        </Button>
      </form>
      <div className="mt-6 text-center">
        <AuthLink onClick={() => { clearErrors(); setView("recover"); }}>Forgot password?</AuthLink>
      </div>
    </SignInFrame>
  );
}

// ── Sign-in frame ────────────────────────────────────────────────────────────

/** Talome's mark (sign-in). */
function TalomeMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="text-foreground">
      <circle cx="12" cy="4.5" r="1.7" /><circle cx="17.1" cy="7" r="1.27" opacity="0.56" /><circle cx="12" cy="9.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="12" r="1.27" opacity="0.56" /><circle cx="12" cy="14.5" r="1.7" /><circle cx="17.5" cy="17" r="1.27" opacity="0.56" /><circle cx="12" cy="19.5" r="0.72" opacity="0.12" /><circle cx="12" cy="4.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="7" r="1.27" opacity="0.56" /><circle cx="12" cy="9.5" r="1.7" /><circle cx="17.5" cy="12" r="1.27" opacity="0.56" /><circle cx="12" cy="14.5" r="0.72" opacity="0.12" /><circle cx="6.5" cy="17" r="1.27" opacity="0.56" /><circle cx="12" cy="19.5" r="1.7" />
    </svg>
  );
}

/**
 * The sign-in screen: the device's desktop wallpaper behind a lock-screen clock
 * and a glass card holding the brand mark, one h1, a subtitle and the form.
 * The card shakes when an attempt is refused, and lifts away as you sign in.
 * Glass falls back to a solid surface under reduced transparency (globals.css),
 * and the shake / lift are skipped under reduced motion.
 */
function SignInFrame({
  title,
  titleKey,
  subtitle,
  children,
  footer = "Your data stays on your server.",
  unlocking,
  shakeClassName,
}: {
  title: string;
  /** Changes when the view changes, so the heading cross-fades. */
  titleKey: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  unlocking: boolean;
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

        {footer ? <p className="mt-6 text-center text-sm text-foreground/70">{footer}</p> : null}
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
    <div className="mb-6 select-none text-center">
      <p className="text-2xl font-medium tabular-nums text-foreground">
        <PopText value={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
      </p>
      <p className="mt-1 text-sm text-foreground/70">
        {now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
      </p>
    </div>
  );
}
