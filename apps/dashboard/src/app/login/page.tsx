"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
        const returnTo = searchParams.get("from") || "/dashboard";
        router.replace(returnTo);
        router.refresh();
      } else {
        setError(data.error ?? "Login failed");
      }
    } catch {
      setError("Network error — is Talome running?");
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
      }
    } catch {
      setError("Network error — is Talome running?");
    } finally {
      setLoading(false);
    }
  }

  function proceedToDashboard() {
    const returnTo = searchParams.get("from") || "/dashboard";
    router.replace(returnTo);
    router.refresh();
  }

  const inputClass = "h-10 bg-muted/30 border-border/50 text-sm placeholder:text-muted-foreground";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <AnimatePresence>
        {ready && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
            className="w-full max-w-xs"
          >
            {/* Brand mark */}
            <div className="flex flex-col items-center mb-8">
              <div className="size-10 rounded-full bg-foreground/[0.06] flex items-center justify-center mb-4">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-muted-foreground">
                  <circle cx="12" cy="4.5" r="1.7" opacity="1"/><circle cx="17.1" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="1.7" opacity="1"/><circle cx="17.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="0.72" opacity="0.12"/><circle cx="12" cy="4.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="1.7" opacity="1"/><circle cx="17.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="1.7" opacity="1"/>
                </svg>
              </div>
              <h1 className="text-lg font-medium tracking-tight text-foreground">
                {view === "recover" ? "Reset password" :
                 view === "setup-recovery-code" || view === "recovery-success" ? "Recovery code" :
                 isFirstTime ? "Welcome to Talome" : "Welcome back"}
              </h1>
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
                  type="password"
                  placeholder={isFirstTime ? "Choose a password (min 8 chars)" : "Password"}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
                  autoComplete={isFirstTime ? "new-password" : "current-password"}
                  className={inputClass}
                />
                <ErrorMessage error={error} />
                <Button type="submit" className="w-full h-10" disabled={loading || !password || (isFirstTime && password.length < 8)}>
                  {loading ? "..." : isFirstTime ? "Create account" : "Sign in"}
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
                  {loading ? "..." : "Reset password"}
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

            {/* Footer */}
            <p className="text-center text-sm text-muted-foreground mt-8">
              Your data stays on your server
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
