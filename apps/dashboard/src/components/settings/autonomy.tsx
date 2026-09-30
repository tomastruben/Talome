"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { trustFetcher } from "@/components/trust/api";
import { SettingsGroup, SettingsRow, settingsRequest } from "@/components/settings/settings-primitives";
import { CORE_URL } from "@/lib/constants";
import { useUser } from "@/hooks/use-user";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type SecurityMode = "permissive" | "cautious" | "locked";

/** What core enforces (GET /api/settings/security-profile). Admin-only. */
export interface SecurityProfile {
  mode: SecurityMode;
  shellAllowlist: string[];
  approvalTtlMinutes: { interactive: number; unattended: number };
  claudeCode: { buildsSkipPrompts: boolean; evolutionSkipsPrompts: boolean };
}

export const SECURITY_PROFILE_URL = `${CORE_URL}/api/settings/security-profile`;

/**
 * The security profile, for admins. Pass `enabled: false` for members (the
 * endpoint is admin-only). A failed load is an error, never a default.
 */
export function useSecurityProfile(enabled = true) {
  return useSWR<SecurityProfile>(enabled ? SECURITY_PROFILE_URL : null, trustFetcher, {
    revalidateOnFocus: true,
  });
}

/**
 * Shown under settings that loaded once but failed to refresh (§4.8 stale
 * data): the values on screen may be out of date, so say so and offer Retry.
 */
export function StaleSettingsLine({ onRetry }: { onRetry: () => void }) {
  return (
    <SettingsRow className="py-2">
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.5} className="shrink-0 text-status-warning" aria-hidden="true" />
        Couldn&apos;t refresh. These may be out of date.
        <button
          type="button"
          className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          Retry
        </button>
      </p>
    </SettingsRow>
  );
}

/** Settings keys for the two Claude Code permission-prompt choices (core ai/autonomy.ts). */
export const PROMPT_SETTING_KEYS = {
  builds: "creator_skip_permission_prompts",
  evolution: "evolution_skip_permission_prompts",
} as const;

export type PromptsKind = keyof typeof PROMPT_SETTING_KEYS;

const PROMPT_COPY: Record<PromptsKind, { title: string; hint: string; on: string; off: string; confirmTitle: string; consequence: string }> = {
  builds: {
    title: "Build apps without permission prompts",
    hint: "When the Assistant builds an app, Claude Code runs in your terminal without asking before each command or file change.",
    on: "Builds run without permission prompts",
    off: "Builds ask before each command",
    confirmTitle: "Build apps without permission prompts?",
    consequence: "Claude Code will run commands and change files in the app's workspace without asking first, with your account's access to this server.",
  },
  evolution: {
    title: "Improve Talome without permission prompts",
    hint: "Evolution runs and bug-hunt fixes open Claude Code in the Talome source folder without asking before each command or file change.",
    on: "Evolution runs without permission prompts",
    off: "Evolution asks before each command",
    confirmTitle: "Improve Talome without permission prompts?",
    consequence: "Claude Code will run commands and edit Talome's own source without asking first, with your account's access to this server.",
  },
};

/**
 * The two server-side choices that replace the old browser "Auto" switch.
 * Turning one on widens what Claude Code may do, so it asks first
 * (destructive tier); turning it off applies at once.
 */
export function ClaudeCodePromptsGroup() {
  const { data, error, mutate, isLoading } = useSecurityProfile(true);
  const confirm = useConfirm();
  const [saving, setSaving] = useState<PromptsKind | null>(null);

  const current = (kind: PromptsKind) =>
    kind === "builds" ? data?.claudeCode.buildsSkipPrompts : data?.claudeCode.evolutionSkipsPrompts;

  async function change(kind: PromptsKind, next: boolean) {
    const key = PROMPT_SETTING_KEYS[kind];
    const copy = PROMPT_COPY[kind];
    const write = () => settingsRequest(`${CORE_URL}/api/settings`, { method: "POST", body: { [key]: String(next) } });
    if (next) {
      const { confirmed } = await confirm({
        tier: "destructive",
        title: copy.confirmTitle,
        consequence: copy.consequence,
        recovery: "You can turn prompts back on at any time. Each run still happens in a terminal you can watch and stop.",
        confirmLabel: "Turn off prompts",
        busyLabel: "Saving…",
        run: write,
        receipt: copy.on,
      });
      if (confirmed) await mutate();
      return;
    }
    setSaving(kind);
    try {
      await write();
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <p className="text-sm font-medium text-foreground">Claude Code permission prompts</p>
      </SettingsRow>
      {error && !data ? (
        <SettingsRow>
          <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} className="shrink-0 text-status-critical" aria-hidden="true" />
          <p className="flex-1 text-sm text-muted-foreground">Couldn&apos;t load these settings.</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void mutate()}>
            Retry
          </Button>
        </SettingsRow>
      ) : (
        (Object.keys(PROMPT_COPY) as PromptsKind[]).map((kind) => {
          const copy = PROMPT_COPY[kind];
          const value = current(kind);
          const id = `claude-prompts-${kind}`;
          return (
            <SettingsRow key={kind}>
              <div className="min-w-0 flex-1">
                <label htmlFor={id} className="text-sm font-medium">
                  {copy.title}
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">{copy.hint}</p>
              </div>
              <Switch
                id={id}
                checked={value === true}
                disabled={isLoading || value === undefined || saving === kind}
                onCheckedChange={(next) => void change(kind, next)}
                className="data-[state=checked]:bg-status-warning"
              />
            </SettingsRow>
          );
        })
      )}
      {error && data ? <StaleSettingsLine onRetry={() => void mutate()} /> : null}
      <SettingsRow className="py-2.5">
        <p className="text-xs text-muted-foreground">
          Headless runs (automatic evolution, the build autofix, remediation) never skip prompts. The terminal&apos;s own
          Auto switch only affects sessions you start there.
        </p>
      </SettingsRow>
    </SettingsGroup>
  );
}

/**
 * One line next to a Build or Run button saying whether that run will skip
 * Claude Code's permission prompts, read from the server setting (admins
 * only; members can't launch these runs).
 */
export function PermissionPromptsNote({ kind, className }: { kind: PromptsKind; className?: string }) {
  const { isAdmin } = useUser();
  // The profile is admin-only; for members the note stays out of the way.
  const { data, error } = useSecurityProfile(isAdmin);
  if (!isAdmin) return null;
  if (error && !data) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        Couldn&apos;t check the permission-prompt setting.
      </p>
    );
  }
  if (!data) return null;
  const skips = kind === "builds" ? data.claudeCode.buildsSkipPrompts : data.claudeCode.evolutionSkipsPrompts;
  const copy = PROMPT_COPY[kind];
  return (
    <p className={cn("text-xs", skips ? "text-status-warning" : "text-muted-foreground", className)}>
      {skips ? copy.on : copy.off} ·{" "}
      <Link
        href="/dashboard/settings/security"
        className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Change
      </Link>
    </p>
  );
}
