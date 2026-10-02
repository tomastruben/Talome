"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthError, AuthField, SignInFrame } from "@/components/trust/auth-shell";
import { RecoveryCodeReveal } from "@/components/trust/recovery-code";
import { useAuthStatus } from "@/hooks/use-setup-status";
import { DURATION_MS } from "@/lib/motion";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { primeSignedInUser, rememberUser, resolveSignInDestination } from "@/lib/sign-in";

export default function SetupPage() {
  return (
    <Suspense>
      <SetupContent />
    </Suspense>
  );
}

interface SetupResponse {
  ok?: boolean;
  error?: unknown;
  code?: string;
  field?: "username" | "password";
  username?: string;
  recoveryCode?: string;
}

/**
 * First-run account creation. It talks to POST /api/auth/setup, which only
 * works while the server has no account, and ends on the recovery code.
 */
function SetupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, retry } = useAuthStatus();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<{ username: string; recoveryCode: string } | null>(null);
  // Account created and code saved: the panel lifts away and the wallpaper sharpens, as after signing in.
  const [unlocking, setUnlocking] = useState(false);
  const unlockingRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const { cache } = useSWRConfig();

  const returnTo = safeRedirectPath(searchParams.get("from"));
  const accountExists = status.state === "ready" && status.accountExists && !created;

  // Someone already set this server up: sign in instead.
  useEffect(() => {
    if (accountExists) router.replace("/login");
  }, [accountExists, router]);

  function clearErrors() {
    if (error) setError(null);
    if (fieldError) setFieldError(null);
  }

  /** Signed in as the new owner: the same hand-over as a sign-in (lib/sign-in.ts). */
  async function goOn(name: string) {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setUnlocking(true);
    const [{ path, user }] = await Promise.all([
      resolveSignInDestination(returnTo),
      new Promise<void>((resolve) => window.setTimeout(resolve, reduceMotion ? DURATION_MS.exitFast : DURATION_MS.sheet)),
    ]);
    // The sign-in screen greets the owner by name next time (only the username is kept).
    rememberUser(user?.username ?? name);
    if (user) primeSignedInUser(cache, user);
    router.replace(path);
    router.refresh();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    const name = username.trim();
    if (name.length < 2) {
      setFieldError({ field: "username", message: "Choose a username with at least 2 characters." });
      return;
    }
    if (password.length < 8) {
      setFieldError({ field: "password", message: "Choose a password with at least 8 characters." });
      return;
    }
    if (password !== confirmPassword) {
      setFieldError({ field: "confirm", message: "The passwords don't match." });
      return;
    }
    setError(null);
    setFieldError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, password }),
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as SetupResponse | null;
      if (res.ok && data?.ok && data.recoveryCode) {
        setCreated({ username: data.username ?? name, recoveryCode: data.recoveryCode });
        return;
      }
      if (data?.code === "already_set_up") {
        router.replace("/login");
        return;
      }
      const message = typeof data?.error === "string" && data.error
        ? data.error
        : "Couldn't create the account. Check that the Talome server is running, then try again.";
      if (data?.field) setFieldError({ field: data.field, message });
      else setError(message);
    } catch {
      setError("Couldn't reach the Talome server. Check that it's running, then try again.");
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    return (
      <SignInFrame
        unlocking={unlocking}
        title="Save your recovery code"
        subtitle="If you forget your password, this code lets you set a new one. Nobody else can reset it for you."
      >
        <RecoveryCodeReveal
          code={created.recoveryCode}
          username={created.username}
          onContinue={() => void goOn(created.username)}
        />
      </SignInFrame>
    );
  }

  if (status.state === "error") {
    return (
      <SignInFrame title="Can't reach Talome" subtitle={status.message}>
        <Button className="h-10 w-full" onClick={retry}>
          Retry
        </Button>
      </SignInFrame>
    );
  }

  if (status.state === "loading" || accountExists) {
    return (
      <SignInFrame title="Set up Talome" subtitle="Checking your server…">
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </SignInFrame>
    );
  }

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  return (
    <SignInFrame
      title="Set up Talome"
      subtitle="Create the owner account. You'll use it to sign in and to approve what agents do on this server."
      // The one place the promise is said out loud: the first time a password is chosen.
      footer="Your data stays on your server."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <AuthField
          label="Username"
          value={username}
          error={errorFor("username")}
          onChange={(e) => { setUsername(e.target.value); clearErrors(); }}
          autoFocus
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <AuthField
          label="Password"
          hint="At least 8 characters."
          revealable
          value={password}
          error={errorFor("password")}
          onChange={(e) => { setPassword(e.target.value); clearErrors(); }}
          autoComplete="new-password"
          required
        />
        <AuthField
          label="Confirm password"
          revealable
          value={confirmPassword}
          error={errorFor("confirm")}
          onChange={(e) => { setConfirmPassword(e.target.value); clearErrors(); }}
          autoComplete="new-password"
          required
        />
        <AuthError message={error} />
        <Button
          type="submit"
          className="h-10 w-full"
          busy={loading}
          busyLabel="Creating account…"
          disabled={!username.trim() || !password || !confirmPassword}
        >
          Create account
        </Button>
      </form>
    </SignInFrame>
  );
}
