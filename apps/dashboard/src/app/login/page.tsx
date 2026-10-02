"use client";

import { Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import {
  AuthError,
  AuthField,
  AuthLink,
  LockAvatar,
  LockButton,
  LockField,
  LockLink,
  LockPlaceholder,
  LockRevealToggle,
  LockSubmit,
  SignInFrame,
} from "@/components/trust/auth-shell";
import { RecoveryCodeReveal } from "@/components/trust/recovery-code";
import { useShake } from "@/components/ui/micro";
import { useAuthStatus } from "@/hooks/use-setup-status";
import { DURATION_MS } from "@/lib/motion";
import { safeRedirectPath } from "@/lib/safe-redirect";
import {
  readRememberedUser,
  primeSignedInUser,
  rememberUser,
  resolveSignInDestination,
  subscribeToRememberedUser,
} from "@/lib/sign-in";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

type View = "login" | "recover" | "recovery-success";

const NETWORK_ERROR = "Couldn't reach the Talome server. Check that it's running, then try again.";
const SIGN_IN_TITLE = "Sign in to Talome";

interface AuthResponse {
  ok?: boolean;
  error?: unknown;
  code?: string;
  field?: string;
  retryAfter?: unknown;
  newRecoveryCode?: string;
}

const SECONDS = new Intl.NumberFormat(undefined, { style: "unit", unit: "second", unitDisplay: "long" });

function messageOf(status: number, body: AuthResponse | null, fallback: string): string {
  // Too many attempts: say how long to wait, not just "Too many requests".
  if (status === 429) {
    const wait = typeof body?.retryAfter === "number" && body.retryAfter > 0 ? Math.ceil(body.retryAfter) : null;
    return wait
      ? `Too many attempts. Wait ${SECONDS.format(wait)}, then try again.`
      : "Too many attempts. Wait a minute, then try again.";
  }
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

/**
 * A ref that only lets go of its own node. Views cross-fade, so the leaving
 * view's field unmounts after the new one mounted; a plain shared ref would be
 * reset to null then, and focus or select would silently stop working.
 */
function useFieldRef(ref: RefObject<HTMLInputElement | null>) {
  return useCallback(
    (node: HTMLInputElement | null) => {
      if (!node) return;
      ref.current = node;
      return () => {
        if (ref.current === node) ref.current = null;
      };
    },
    [ref],
  );
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, retry } = useAuthStatus();
  // The last person who signed in on this browser (only their username is kept).
  const remembered = useSyncExternalStore(subscribeToRememberedUser, readRememberedUser, () => null);
  const [someoneElse, setSomeoneElse] = useState(false);
  const knownUser = someoneElse ? null : remembered;
  const [view, setView] = useState<View>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [shownRecoveryCode, setShownRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The server turned the credentials down (not a network failure): the password field is what to fix.
  const [refused, setRefused] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  // Signed in: the lock screen lifts away and the wallpaper sharpens before the next screen appears.
  const [unlocking, setUnlocking] = useState(false);
  const unlockingRef = useRef(false);
  const { shake, shakeClassName } = useShake();
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const usernameField = useFieldRef(usernameRef);
  const passwordField = useFieldRef(passwordRef);
  const messageId = useId();
  const reduceMotion = useReducedMotion();
  const { cache } = useSWRConfig();

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
    if (refused) setRefused(false);
    if (fieldError) setFieldError(null);
  }

  /**
   * Signed in as `name`: remember who (the username only), play the unlock,
   * and go where this person's dashboard opens. The destination is read from
   * the new session while the unlock plays, so someone who uses desktop mode
   * lands on the desktop directly instead of passing through the classic
   * dashboard.
   */
  async function goOn(name: string) {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setUnlocking(true);
    const [{ path, user }] = await Promise.all([
      resolveSignInDestination(returnTo),
      wait(reduceMotion ? DURATION_MS.exitFast : DURATION_MS.sheet),
    ]);
    // Remembered only now, once the lock screen has faded: written earlier,
    // the screen would re-render as the new person on its way out.
    rememberUser(user?.username ?? name);
    // Hand the fresh user to useUser, so the dashboard opens without a loading step.
    if (user) primeSignedInUser(cache, user);
    router.replace(path);
    router.refresh();
  }

  /** A refused attempt: say why, shake, and select the password to retype. */
  function reject(message: string, selectPassword: boolean) {
    setError(message);
    setRefused(selectPassword);
    shake();
    if (selectPassword) requestAnimationFrame(() => passwordRef.current?.select());
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    if (loading || unlockingRef.current) return;
    // Read what the fields hold now: a password manager's fill can reach the
    // field before it reaches React state.
    const typedName = usernameRef.current?.value ?? username;
    const typedPassword = passwordRef.current?.value ?? password;
    if (typedName !== username) setUsername(typedName);
    if (typedPassword !== password) setPassword(typedPassword);
    const name = (knownUser ?? typedName).trim();
    if (!name) {
      setFieldError({ field: "username", message: "Enter your username." });
      shake();
      usernameRef.current?.focus();
      return;
    }
    if (!typedPassword) {
      setFieldError({ field: "password", message: "Enter your password." });
      shake();
      passwordRef.current?.focus();
      return;
    }
    setError(null);
    setRefused(false);
    setFieldError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, password: typedPassword }),
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as AuthResponse | null;
      if (res.ok && data?.ok) {
        setLoading(false);
        void goOn(name);
        return;
      }
      if (data?.code === "setup_required") {
        retry();
        return;
      }
      reject(messageOf(res.status, data, "Couldn't sign in. Check your username and password, then try again."), true);
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
        reject(messageOf(res.status, data, "Couldn't reset the password. Check the username and recovery code, then try again."), false);
      }
    } catch {
      reject(NETWORK_ERROR, false);
    } finally {
      setLoading(false);
    }
  }

  /** Someone other than the remembered person: ask for a username (nothing is forgotten). */
  function signInAsSomeoneElse() {
    clearErrors();
    setSomeoneElse(true);
    setUsername("");
    setPassword("");
    setRevealed(false);
  }

  /** Back to the remembered person. */
  function signInAsRemembered() {
    clearErrors();
    setSomeoneElse(false);
    setPassword("");
    setRevealed(false);
  }

  function openRecover() {
    clearErrors();
    // Resetting the remembered person's password: their name is already known.
    if (knownUser && !username.trim()) setUsername(knownUser);
    setView("recover");
  }

  if (status.state === "error") {
    return (
      <SignInFrame layout="lock" unlocking={unlocking} titleKey="error" title="Can't reach Talome" subtitle={status.message}>
        <LockButton onClick={retry}>Retry</LockButton>
      </SignInFrame>
    );
  }

  if (status.state === "loading" || noAccount) {
    return (
      <SignInFrame layout="lock" unlocking={unlocking} titleKey="loading" title={SIGN_IN_TITLE}>
        <LockPlaceholder knownUser={Boolean(knownUser)} />
      </SignInFrame>
    );
  }

  if (view === "recovery-success") {
    return (
      <SignInFrame
        unlocking={unlocking}
        shakeClassName={shakeClassName}
        titleKey="code"
        title="Save your new recovery code"
        subtitle="Your password is reset and you're signed in. The code you used no longer works."
      >
        <RecoveryCodeReveal code={shownRecoveryCode} username={username.trim()} onContinue={() => void goOn(username)} />
      </SignInFrame>
    );
  }

  if (view === "recover") {
    const mismatch = fieldError?.field === "confirm" ? fieldError.message : null;
    return (
      <SignInFrame
        unlocking={unlocking}
        shakeClassName={shakeClassName}
        titleKey="recover"
        title="Reset password"
        subtitle="Enter your recovery code to set a new password."
      >
        <form onSubmit={handleRecover} className="flex flex-col gap-4" noValidate>
          <AuthField
            label="Username"
            name="username"
            value={username}
            onChange={(e) => { setUsername(e.target.value); clearErrors(); }}
            autoFocus={!username}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          <AuthField
            label="Recovery code"
            hint="Upper or lower case, with or without hyphens."
            value={recoveryCode}
            onChange={(e) => { setRecoveryCode(e.target.value); clearErrors(); }}
            autoFocus={Boolean(username)}
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

  const usernameError = fieldError?.field === "username" ? fieldError.message : null;
  const passwordError = fieldError?.field === "password" ? fieldError.message : null;
  const message = usernameError ?? passwordError ?? error;

  return (
    <SignInFrame layout="lock" unlocking={unlocking} titleKey={knownUser ? "known" : "anyone"} title={SIGN_IN_TITLE}>
      <form onSubmit={handleLogin} className="flex w-full flex-col items-center" noValidate>
        <LockAvatar name={knownUser} />
        {knownUser ? (
          <>
            <p className="tm-on-scrim mt-3 max-w-full truncate text-base font-medium text-foreground">{knownUser}</p>
            {/* Password managers pair the password with this username when they save or fill it */}
            <input type="text" name="username" autoComplete="username" value={knownUser} readOnly hidden />
          </>
        ) : null}

        <div className={cn("mt-4 flex w-full flex-col gap-2", shakeClassName)}>
          {knownUser ? null : (
            <LockField
              ref={usernameField}
              label="Username"
              name="username"
              placeholder="Username"
              value={username}
              invalid={Boolean(usernameError)}
              describedBy={usernameError ? messageId : undefined}
              onChange={(e) => { setUsername(e.target.value); clearErrors(); }}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
          <LockField
            ref={passwordField}
            label="Password"
            name="password"
            type={revealed ? "text" : "password"}
            placeholder={knownUser ? "Enter password" : "Password"}
            value={password}
            invalid={refused || Boolean(passwordError)}
            describedBy={passwordError || error ? messageId : undefined}
            onChange={(e) => {
              setPassword(e.target.value);
              if (!e.target.value) setRevealed(false);
              clearErrors();
            }}
            autoFocus={Boolean(knownUser)}
            autoComplete="current-password"
            required
            trailing={
              <>
                {password ? <LockRevealToggle revealed={revealed} onToggle={() => setRevealed((value) => !value)} /> : null}
                <LockSubmit
                  label="Sign in"
                  busy={loading || unlocking}
                  busyLabel={unlocking ? "Opening Talome…" : "Signing in…"}
                />
              </>
            }
          />
        </div>

        <AuthError onScrim id={messageId} message={message} className="mt-3" />

        <div className="mt-3 flex max-w-full flex-wrap items-center justify-center gap-x-4">
          <LockLink onClick={openRecover}>Forgot password?</LockLink>
          {knownUser ? (
            <LockLink onClick={signInAsSomeoneElse}>Sign in as someone else</LockLink>
          ) : remembered ? (
            <LockLink onClick={signInAsRemembered}>
              <span className="min-w-0 truncate">Sign in as {remembered}</span>
            </LockLink>
          ) : null}
        </div>
      </form>
    </SignInFrame>
  );
}
