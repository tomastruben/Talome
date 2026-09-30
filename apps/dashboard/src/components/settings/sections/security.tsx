"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  HugeiconsIcon,
  SecurityCheckIcon,
  SquareUnlock02Icon,
  LockedIcon,
  ComputerTerminal01Icon,
  Activity01Icon,
  Plug02Icon,
  ArrowRight01Icon,
  AlertCircleIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { SettingsGroup, SettingsRow, SaveRow, settingsRequest } from "@/components/settings/settings-primitives";
import { ClaudeCodePromptsGroup, useSecurityProfile, type SecurityMode } from "@/components/settings/autonomy";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card-group";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { usePendingApprovals } from "@/components/trust/api";

const MODE_RANK: Record<SecurityMode, number> = { locked: 0, cautious: 1, permissive: 2 };

const MODES: RadioCardOption<SecurityMode>[] = [
  {
    value: "permissive",
    title: "Permissive",
    description: "Agents can change anything without asking. Shell commands are checked against a blocklist only.",
    icon: SquareUnlock02Icon,
  },
  {
    value: "cautious",
    title: "Cautious",
    description: "Agents read freely and make everyday changes. Destructive actions wait for your approval, and the shell only runs the commands listed below.",
    icon: SecurityCheckIcon,
    badge: "Recommended",
  },
  {
    value: "locked",
    title: "Locked",
    description: "Agents can only look. No changes, no shell, no commands inside containers.",
    icon: LockedIcon,
  },
];

const MODE_LABEL: Record<SecurityMode, string> = { permissive: "Permissive", cautious: "Cautious", locked: "Locked" };

const TRUST_LINKS: { href: string; label: string; hint: string; icon: IconSvgElement; badge?: "approvals" }[] = [
  {
    href: "/dashboard/settings/approvals",
    label: "Approvals",
    hint: "Destructive agent actions waiting for your decision",
    icon: SecurityCheckIcon,
    badge: "approvals",
  },
  {
    href: "/dashboard/settings/mcp",
    label: "AI agents",
    hint: "Connected agents and what each one may do",
    icon: Plug02Icon,
  },
  {
    href: "/dashboard/settings/audit",
    label: "Audit log",
    hint: "Who did what, from where, and how it went",
    icon: Activity01Icon,
  },
];

function TrustLinks() {
  const { count } = usePendingApprovals(true);
  return (
    <SettingsGroup>
      {TRUST_LINKS.map((link) => (
        <Link key={link.href} href={link.href} className="block outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <SettingsRow className="hover:bg-muted/30 transition-colors duration-150">
            <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
              <HugeiconsIcon icon={link.icon} size={16} className="text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{link.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{link.hint}</p>
            </div>
            {link.badge === "approvals" && count > 0 && (
              <Badge variant="count" aria-label={`${count} waiting`}>{count}</Badge>
            )}
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-muted-foreground shrink-0" aria-hidden="true" />
          </SettingsRow>
        </Link>
      ))}
    </SettingsGroup>
  );
}

const MIN_BACKUP_PASSWORD_LENGTH = 8;

/**
 * The terminal daemon's own login, for when the main server is down. Only an
 * admin can set or change it (through the admin-only terminal proxy).
 */
function BackupTerminalPassword() {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${CORE_URL}/api/terminal/backup-auth/status`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { hasPassword?: boolean }) => {
        if (cancelled) return;
        if (typeof data?.hasPassword !== "boolean") throw new Error("bad response");
        setHasPassword(data.hasPassword);
        setStatusError(false);
      })
      .catch(() => {
        if (!cancelled) setStatusError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const save = async () => {
    if (password.length < MIN_BACKUP_PASSWORD_LENGTH) {
      toast.error(`Use at least ${MIN_BACKUP_PASSWORD_LENGTH} characters.`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${CORE_URL}/api/terminal/backup-auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setHasPassword(true);
        setPassword("");
        toast.success("Saved the backup terminal password");
      } else {
        toast.error(data.error || "Couldn't save the password. Try again.");
      }
    } catch {
      toast.error("Couldn't reach the terminal daemon. Check that it's running, then try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            Backup terminal
          </p>
        </div>
      </SettingsRow>
      <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
        <div className="flex-1 min-w-0">
          <Label htmlFor="backup-terminal-password" className="text-sm font-medium cursor-pointer">
            {hasPassword ? "Change password" : "Set password"}
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Logs in to the terminal daemon directly when the dashboard is down.
            {hasPassword === false && " Not set yet, so the backup terminal stays closed until you set one."}
          </p>
          {statusError && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
              <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.5} className="text-status-critical shrink-0" aria-hidden="true" />
              Couldn&apos;t check whether a password is set.
              <button type="button" className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </p>
          )}
        </div>
        <Input
          id="backup-terminal-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${MIN_BACKUP_PASSWORD_LENGTH} characters`}
          className="text-sm h-8 w-full sm:w-72"
          autoComplete="new-password"
        />
      </SettingsRow>
      {password && <SaveRow onSave={() => void save()} saving={saving} />}
    </SettingsGroup>
  );
}

export function SecuritySection() {
  const { data: profile, error, isLoading, mutate } = useSecurityProfile(true);
  const confirm = useConfirm();
  const [saving, setSaving] = useState<SecurityMode | null>(null);

  const saveMode = (next: SecurityMode) =>
    settingsRequest(`${CORE_URL}/api/settings`, { method: "POST", body: { security_mode: next } }, "Couldn't change the security mode. Try again.");

  const choose = async (next: SecurityMode) => {
    const current = profile?.mode;
    if (!current || next === current || saving) return;
    if (MODE_RANK[next] > MODE_RANK[current]) {
      // Widening what agents may do always asks first.
      const { confirmed } = await confirm({
        tier: "destructive",
        title: `Switch to ${MODE_LABEL[next]} mode?`,
        consequence: next === "permissive"
          ? "Agents could uninstall apps, delete files and run shell commands without asking you first."
          : "Agents can make everyday changes. Destructive actions still wait for your approval.",
        recovery: "You can switch back at any time. Past actions stay in the audit log.",
        confirmLabel: `Switch to ${MODE_LABEL[next]}`,
        busyLabel: "Switching mode…",
        run: () => saveMode(next),
        receipt: `Security mode is now ${MODE_LABEL[next]}`,
      });
      if (confirmed) await mutate();
      return;
    }
    setSaving(next);
    try {
      await saveMode(next);
      await mutate();
      toast.success(`Security mode is now ${MODE_LABEL[next]}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the security mode. Try again.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Choose what agents, including the Assistant, may do on your server without asking you.
      </p>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p id="security-mode-label" className="text-sm font-medium text-foreground">
            Security mode
          </p>
        </SettingsRow>

        {error && !profile ? (
          <SettingsRow>
            <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} className="shrink-0 text-status-critical" aria-hidden="true" />
            <div className="flex-1 min-w-0" role="alert">
              <p className="text-sm font-medium">Couldn&apos;t load the security mode</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {error instanceof Error ? error.message : "Check that the Talome server is reachable."} Agents keep using the mode that is saved.
              </p>
            </div>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void mutate()}>
              Retry
            </Button>
          </SettingsRow>
        ) : isLoading || !profile ? (
          <SettingsRow>
            <div className="w-full grid gap-2" aria-hidden="true">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          </SettingsRow>
        ) : (
          <SettingsRow>
            <RadioCardGroup
              className="w-full"
              aria-labelledby="security-mode-label"
              value={saving ?? profile.mode}
              disabled={saving !== null}
              onValueChange={(next) => void choose(next)}
              options={MODES}
            />
          </SettingsRow>
        )}
      </SettingsGroup>

      {profile?.mode === "cautious" && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} className="text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium text-foreground">
                Shell allowlist
              </p>
            </div>
          </SettingsRow>

          <SettingsRow>
            <div className="w-full">
              <p className="text-xs text-muted-foreground mb-3">
                In Cautious mode, the shell tool runs only these commands. Anything else is refused.
              </p>
              <ul className="flex flex-wrap gap-1.5" aria-label="Allowed shell commands">
                {profile.shellAllowlist.map((cmd) => (
                  <li
                    key={cmd}
                    className="inline-block rounded-md bg-muted px-2 py-1 text-xs font-mono text-muted-foreground"
                  >
                    {cmd}
                  </li>
                ))}
              </ul>
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}

      <ClaudeCodePromptsGroup />

      <TrustLinks />

      <BackupTerminalPassword />

      <p className="text-xs text-muted-foreground px-1">
        A new mode applies from the next tool call, including in conversations that are already open.
      </p>
    </div>
  );
}
