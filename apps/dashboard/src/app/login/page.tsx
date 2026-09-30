"use client";

import { Suspense, useState, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PopText, useShake } from "@/components/ui/micro";
import { DEFAULT_SIGN_IN_WALLPAPER, readStoredWallpaper } from "@/lib/wallpaper";

const MOTION = { duration: 0.18, ease: "easeOut" } as const;

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

type View = "login" | "recover" | "setup-recovery-code" | "recovery-success";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [shownRecoveryCode, setShownRecoveryCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isFirstTime, setIsFirstTime] = useState(false);
  const [ready, setReady] = useState(false);
  // Signed in: the card lifts away and the wallpaper eases forward before the dashboard appears
  const [unlocking, setUnlocking] = useState(false);
  const { shake, shakeClassName } = useShake();
  const passwordRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();

  function enter(returnTo: string) {
    setUnlocking(true);
    window.setTimeout(() => {
      router.replace(returnTo);
      router.refresh();
    }, reduceMotion ? 0 : 260);
  }

  function reject(message: string) {
    setError(message);
    shake();
    // Like a lock screen: the password is selected, ready to retype
    requestAnimationFrame(() => passwordRef.current?.select());
  }

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data: { passwordConfigured: boolean }) => {
        setIsFirstTime(!data.passwordConfigured);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim() || "admin", password }),
        credentials: "include",
      });

      const data = await res.json() as { ok?: boolean; error?: string; setup?: boolean; recoveryCode?: string };

      if (res.ok && data.ok) {
        // First-time setup — show recovery code before proceeding
        if (data.setup && data.recoveryCode) {
          setShownRecoveryCode(data.recoveryCode);
          setView("setup-recovery-code");
          return;
        }
        enter(searchParams.get("from") || "/dashboard");
        return;
      } else {
        reject(data.error ?? "Login failed");
      }
    } catch {
      reject("Network error — is Talome running?");
    } finally {
      setLoading(false);
    }
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          recoveryCode: recoveryCode.trim(),
          newPassword,
        }),
        credentials: "include",
      });

      const data = await res.json() as { ok?: boolean; error?: string; newRecoveryCode?: string };

      if (res.ok && data.ok) {
        setShownRecoveryCode(data.newRecoveryCode ?? "");
        setView("recovery-success");
      } else {
        setError(data.error ?? "Recovery failed");
        shake();
      }
    } catch {
      setError("Network error — is Talome running?");
      shake();
    } finally {
      setLoading(false);
    }
  }

  function proceedToDashboard() {
    enter(searchParams.get("from") || "/dashboard");
  }

  const inputClass = "h-10 bg-background/40 border-border/60 text-sm placeholder:text-muted-foreground";
  const setupStep = isFirstTime && view === "login" ? 1 : view === "setup-recovery-code" ? 2 : null;

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center bg-background p-6 overflow-hidden">
      <SignInBackdrop unlocking={unlocking} />

      <AnimatePresence>
        {ready && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={unlocking ? { opacity: 0, y: -8, scale: 1.02, filter: "blur(4px)" } : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            transition={unlocking ? { duration: 0.26, ease: [0.22, 1, 0.36, 1] } : MOTION}
            className="relative z-10 w-full max-w-sm flex flex-col items-center"
          >
            <LockClock />

            <div className={`w-full rounded-2xl border border-white/10 bg-background/60 backdrop-blur-xl p-6 ${shakeClassName ?? ""}`}>
            {setupStep && <SetupSteps step={setupStep} />}

            {/* Brand mark */}
            <div className="flex flex-col items-center mb-8">
              <div className="size-10 rounded-full bg-foreground/[0.06] flex items-center justify-center mb-4">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-muted-foreground">
                  <circle cx="12" cy="4.5" r="1.7" opacity="1"/><circle cx="17.1" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="1.7" opacity="1"/><circle cx="17.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="0.72" opacity="0.12"/><circle cx="12" cy="4.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="1.7" opacity="1"/><circle cx="17.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="1.7" opacity="1"/>
                </svg>
              </div>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.h1
                  key={view === "recover" ? "recover" : view === "setup-recovery-code" || view === "recovery-success" ? "code" : "welcome"}
                  initial={{ opacity: 0, y: 4, filter: "blur(2px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className="text-lg font-medium tracking-tight text-foreground"
                >
                  {view === "recover" ? "Reset password" :
                   view === "setup-recovery-code" || view === "recovery-success" ? "Recovery code" :
                   isFirstTime ? "Welcome to Talome" : "Welcome back"}
                </motion.h1>
              </AnimatePresence>
              <p className="text-sm text-muted-foreground mt-1">
                {view === "recover"
                  ? "Enter your recovery code to set a new password."
                  : view === "setup-recovery-code"
                  ? "Save this code — it\u2019s your only way to reset your password."
                  : view === "recovery-success"
                  ? "Password reset. Save your new recovery code."
                  : isFirstTime
                  ? "Create your admin account to get started."
                  : "Enter your credentials to continue."}
              </p>
            </div>

            {/* ── Login form ──────────────────────────────── */}
            {view === "login" && (
              <form onSubmit={handleLogin} className="space-y-4">
                <Input
                  type="text"
                  placeholder={isFirstTime ? "Choose a username" : "Username"}
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); if (error) setError(""); }}
                  autoFocus
                  autoComplete="username"
                  className={inputClass}
                />
                <Input
                  ref={passwordRef}
                  type="password"
                  placeholder={isFirstTime ? "Choose a password (min 8 chars)" : "Password"}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
                  autoComplete={isFirstTime ? "new-password" : "current-password"}
                  aria-invalid={error ? true : undefined}
                  className={inputClass}
                />
                <ErrorMessage error={error} />
                <Button type="submit" className="w-full h-10" disabled={loading || unlocking || !password || (isFirstTime && password.length < 8)}>
                  {loading || unlocking ? <Spinner className="size-4" /> : isFirstTime ? "Create account" : "Sign in"}
                </Button>
              </form>
            )}

            {/* ── Recovery form ───────────────────────────── */}
            {view === "recover" && (
              <form onSubmit={handleRecover} className="space-y-4">
                <Input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); if (error) setError(""); }}
                  autoFocus
                  autoComplete="username"
                  className={inputClass}
                />
                <Input
                  type="text"
                  placeholder="Recovery code"
                  value={recoveryCode}
                  onChange={(e) => { setRecoveryCode(e.target.value); if (error) setError(""); }}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                />
                <Input
                  type="password"
                  placeholder="New password (min 8 chars)"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); if (error) setError(""); }}
                  autoComplete="new-password"
                  className={inputClass}
                />
                <ErrorMessage error={error} />
                <Button type="submit" className="w-full h-10" disabled={loading || !username || !recoveryCode || newPassword.length < 8}>
                  {loading ? <Spinner className="size-4" /> : "Reset password"}
                </Button>
              </form>
            )}

            {/* ── Recovery code display (after setup or recovery) ── */}
            {(view === "setup-recovery-code" || view === "recovery-success") && (
              <RecoveryCodeDisplay code={shownRecoveryCode} onContinue={proceedToDashboard} />
            )}

            {/* ── Forgot password link ────────────────────── */}
            {view === "login" && !isFirstTime && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => { setError(""); setView("recover"); }}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Forgot password?
                </button>
              </div>
            )}

            {/* ── Back to login ───────────────────────────── */}
            {view === "recover" && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => { setError(""); setView("login"); }}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Back to sign in
                </button>
              </div>
            )}

            </div>

            {/* Footer */}
            <p className="text-center text-sm text-foreground/70 mt-6">
              Your data stays on your server
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
          transition: reduceMotion ? "none" : unlocking
            ? "transform 320ms cubic-bezier(0.22, 1, 0.36, 1)"
            : "opacity 180ms ease-out, transform 180ms ease-out",
        }}
      />
      {/* The scrim lifts as you sign in, so the desktop seems to come forward */}
      <div className={`absolute inset-0 bg-background/45 transition-opacity duration-300 ${unlocking ? "opacity-0" : ""}`} />
    </div>
  );
}

/** Time and date above the sign-in card, like a lock screen. */
function subscribeToClock(onTick: () => void) {
  const timer = setInterval(onTick, 10_000);
  return () => clearInterval(timer);
}

/** Current time, rounded to the minute so the snapshot is stable between ticks. */
function clockSnapshot(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function LockClock() {
  const minute = useSyncExternalStore(subscribeToClock, clockSnapshot, () => null);

  if (minute === null) return <div className="h-16 mb-6" />;
  const now = new Date(minute);
  return (
    <div className="mb-6 text-center select-none">
      <p className="text-2xl font-medium tabular-nums text-foreground">
        <PopText value={now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
      </p>
      <p className="text-sm text-foreground/70 mt-1">
        {now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
      </p>
    </div>
  );
}

/** First run: where the person is in setting up their server. */
function SetupSteps({ step }: { step: 1 | 2 }) {
  const steps = ["Create your account", "Save your recovery code"];
  return (
    <ol className="flex items-center justify-center gap-2 mb-6" aria-label={`Step ${step} of ${steps.length}`}>
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={`h-1.5 rounded-full transition-all duration-150 ease-out ${i + 1 === step ? "w-6 bg-foreground" : i + 1 < step ? "w-1.5 bg-foreground/60" : "w-1.5 bg-foreground/20"}`}
            title={label}
          />
        </li>
      ))}
      <span className="sr-only">{steps[step - 1]}</span>
    </ol>
  );
}

function RecoveryCodeDisplay({ code, onContinue }: { code: string; onContinue: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text for manual copy
      const el = document.getElementById("recovery-code");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/40 border border-border/50 p-4 text-center">
        <p className="text-xs text-muted-foreground mb-3">Your recovery code</p>
        <p
          id="recovery-code"
          className="font-mono text-base tracking-widest text-foreground select-all break-all mb-3"
        >
          {code}
        </p>
        <button
          type="button"
          onClick={copyCode}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.06] px-3 py-1.5 text-xs text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground transition-colors"
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              Copied
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              Copy to clipboard
            </>
          )}
        </button>
      </div>
      <p className="text-xs text-muted-foreground text-center">
        This code won&apos;t be shown again. Store it somewhere safe — it&apos;s your only way to reset your password.
      </p>
      <Button className="w-full h-10" onClick={onContinue}>
        I&apos;ve saved it — continue
      </Button>
    </div>
  );
}

function ErrorMessage({ error }: { error: string }) {
  return (
    <AnimatePresence mode="wait">
      {error && (
        <motion.p
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.15 }}
          className="text-sm text-destructive overflow-hidden"
        >
          {error}
        </motion.p>
      )}
    </AnimatePresence>
  );
}
