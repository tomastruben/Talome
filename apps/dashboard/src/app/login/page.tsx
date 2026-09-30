"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthError, AuthField, AuthLink, SignInFrame } from "@/components/trust/auth-shell";
import { RecoveryCodeReveal } from "@/components/trust/recovery-code";
import { useShake } from "@/components/ui/micro";
import { useAuthStatus } from "@/hooks/use-setup-status";
import { DURATION_MS } from "@/lib/motion";
import { safeRedirectPath } from "@/lib/safe-redirect";

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
