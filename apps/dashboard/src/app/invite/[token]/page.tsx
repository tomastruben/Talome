"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RecoveryCodeReveal } from "@/components/trust/recovery-code";

interface InvitationPreview {
  email: string;
  role: "admin" | "member";
  expiresAt: string;
}

export default function AcceptInvitationPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/auth/invitations/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = await response.json() as InvitationPreview & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Invitation unavailable");
        setInvitation(data);
      })
      .catch((fetchError) => setError(fetchError instanceof Error ? fetchError.message : "Invitation unavailable"))
      .finally(() => setLoading(false));
  }, [token]);

  async function acceptInvitation(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json() as { recoveryCode?: string; error?: string };
      if (!response.ok || !data.recoveryCode) throw new Error(typeof data.error === "string" ? data.error : "Could not accept invitation");
      setRecoveryCode(data.recoveryCode);
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : "Could not accept invitation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="size-10 rounded-full bg-foreground/[0.06] flex items-center justify-center mb-4">
            <span className="text-lg text-muted-foreground" aria-hidden="true">✦</span>
          </div>
          <h1 className="text-lg font-medium tracking-tight">
            {recoveryCode ? "Welcome to Talome" : "Join this Talome"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {recoveryCode
              ? "Your account is ready. If you forget your password, this recovery code lets you set a new one, so save it before you go on."
              : invitation
                ? `${invitation.email} was invited as ${invitation.role === "admin" ? "an admin" : "a family member"}.`
                : "Checking your invitation…"}
          </p>
        </div>

        {loading ? (
          <div className="h-36 rounded-2xl bg-muted/30 motion-safe:animate-pulse" />
        ) : recoveryCode ? (
          // The same reveal as first-run setup: grouped code, Copy with a
          // fallback, Download, Print, and "type the last group" before going on.
          <RecoveryCodeReveal
            code={recoveryCode}
            username={username.trim() || undefined}
            continueLabel="Open Talome"
            onContinue={() => { router.replace("/dashboard"); router.refresh(); }}
          />
        ) : invitation ? (
          <form onSubmit={acceptInvitation} className="space-y-4">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Choose a username" autoComplete="username" autoFocus />
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Choose a password (min 8 characters)" autoComplete="new-password" />
            <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm password" autoComplete="new-password" />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting || username.trim().length < 2 || password.length < 8 || !confirmPassword}>
              {submitting ? "Creating account…" : "Create my account"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">This single-use invitation expires {new Date(invitation.expiresAt).toLocaleDateString()}.</p>
          </form>
        ) : (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center">
            <p className="text-sm text-destructive">{error || "Invitation unavailable"}</p>
            <p className="text-xs text-muted-foreground mt-1">Ask the Talome admin for a new invitation.</p>
          </div>
        )}
      </div>
    </main>
  );
}
