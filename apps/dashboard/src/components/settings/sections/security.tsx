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
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { SettingsGroup, SettingsRow, SaveRow } from "@/components/settings/settings-primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { usePendingApprovals } from "@/components/trust/api";

type SecurityMode = "cautious" | "permissive" | "locked";

const MODES: { value: SecurityMode; label: string; description: string; icon: IconSvgElement }[] = [
  {
    value: "permissive",
    label: "Permissive",
    description:
      "AI has full access. Shell commands use a blocklist. Best for advanced users.",
    icon: SquareUnlock02Icon,
  },
  {
    value: "cautious",
    label: "Cautious",
    description:
      "AI can read freely. Destructive actions wait for your approval. Shell commands restricted to safe defaults.",
    icon: SecurityCheckIcon,
  },
  {
    value: "locked",
    label: "Locked",
    description:
      "AI can only read. No modifications, no shell, no container exec.",
    icon: LockedIcon,
  },
];

const SHELL_ALLOWLIST = [
  "ls", "cat", "head", "tail", "df", "du", "free", "uptime", "whoami",
  "date", "uname", "pwd", "wc", "sort", "grep", "awk", "sed", "stat",
  "file", "which", "top", "ps", "env", "echo", "test", "id", "hostname",
  "mkdir", "touch", "cp", "mv", "tar", "gzip", "gunzip", "zip", "unzip",
  "ping", "curl", "dig", "nslookup", "ss", "ifconfig", "ip", "docker",
  "find", "locate", "rg",
];

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
    label: "AI Agents",
    hint: "Per-client tokens and what each one may do",
    icon: Plug02Icon,
  },
  {
    href: "/dashboard/settings/audit",
    label: "Audit Log",
    hint: "Who did what, from where, and how it went",
    icon: Activity01Icon,
  },
];

function TrustLinks() {
  const { count } = usePendingApprovals(true);
  return (
    <SettingsGroup>
      {TRUST_LINKS.map((link) => (
        <Link key={link.href} href={link.href} className="block">
          <SettingsRow className="hover:bg-muted/30 transition-colors">
            <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
              <HugeiconsIcon icon={link.icon} size={16} className="text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{link.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{link.hint}</p>
            </div>
            {link.badge === "approvals" && count > 0 && (
              <Badge className="bg-status-warning text-background tabular-nums">{count}</Badge>
            )}
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-dim-foreground shrink-0" />
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
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${CORE_URL}/api/terminal/backup-auth/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { hasPassword?: boolean } | null) => setHasPassword(data?.hasPassword ?? null))
      .catch(() => setHasPassword(null));
  }, []);

  const save = async () => {
    if (password.length < MIN_BACKUP_PASSWORD_LENGTH) {
      toast.error(`Use at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${CORE_URL}/api/terminal/backup-auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setHasPassword(true);
        setPassword("");
        toast("Backup terminal password saved");
      } else {
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Terminal daemon unreachable");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} className="text-muted-foreground" />
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Backup Terminal
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
            {hasPassword === false && " Not set yet — the backup terminal stays closed until you set one."}
          </p>
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
  const [mode, setMode] = useState<SecurityMode>("cautious");
  const [savedMode, setSavedMode] = useState<SecurityMode>("cautious");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const stored = data.security_mode as SecurityMode | undefined;
        if (stored && MODES.some((m) => m.value === stored)) {
          setMode(stored);
          setSavedMode(stored);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const dirty = mode !== savedMode;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ security_mode: mode }),
      });
      const data = await res.json();
      if (data.ok) {
        setSavedMode(mode);
        toast("Security mode updated");
      } else {
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Control what the AI assistant is allowed to do on your server.
      </p>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Security Mode
          </p>
        </SettingsRow>

        {loading ? (
          <SettingsRow>
            <div className="w-full grid gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg bg-muted/40 px-4 py-3">
                  <Skeleton className="size-8 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-full max-w-xs" />
                  </div>
                </div>
              ))}
            </div>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow>
              <div className="w-full grid gap-3">
                {MODES.map(({ value, label, description, icon }) => {
                  const active = mode === value;
                  return (
                    <button
                      key={value}
                      onClick={() => setMode(value)}
                      className={cn(
                        "flex items-start gap-3 rounded-lg px-4 py-3 text-left transition-colors",
                        active
                          ? "bg-foreground/10 ring-1 ring-foreground/20"
                          : "bg-muted/40 hover:bg-muted/60",
                      )}
                    >
                      <div
                        className={cn(
                          "size-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                          active
                            ? "bg-foreground/10 text-foreground"
                            : "bg-muted/50 text-muted-foreground",
                        )}
                      >
                        <HugeiconsIcon icon={icon} size={16} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className={cn(
                            "text-sm font-medium",
                            active ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {label}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </SettingsRow>

            {dirty && <SaveRow onSave={() => void save()} saving={saving} />}
          </>
        )}
      </SettingsGroup>

      {mode === "cautious" && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} className="text-muted-foreground" />
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Shell Allowlist
              </p>
            </div>
          </SettingsRow>

          <SettingsRow>
            <div className="w-full">
              <p className="text-xs text-muted-foreground mb-3">
                In cautious mode, only these commands are permitted in the shell tool.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SHELL_ALLOWLIST.map((cmd) => (
                  <span
                    key={cmd}
                    className="inline-block rounded-md bg-muted/50 px-2 py-1 text-xs font-mono text-muted-foreground"
                  >
                    {cmd}
                  </span>
                ))}
              </div>
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}

      <TrustLinks />

      <BackupTerminalPassword />

      <p className="text-xs text-muted-foreground px-1">
        Security mode changes take effect immediately for new AI interactions.
        Active conversations will use the updated mode on their next tool call.
      </p>
    </div>
  );
}
