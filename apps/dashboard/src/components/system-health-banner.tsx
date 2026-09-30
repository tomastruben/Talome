"use client";

import Link from "next/link";
import { useIsOnline, type OnlineStatus } from "@/hooks/use-is-online";
import { failingChecksLabel } from "@/lib/health";
import { useUser } from "@/hooks/use-user";
import { AlertCircleIcon, Alert02Icon } from "@/components/icons";
import { Banner, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import { Button } from "@/components/ui/button";
import { openPalette } from "@/lib/palette";
import { cn } from "@/lib/utils";

/**
 * Tint recipe only (spec §2.2: a solid banner is never used). A solid
 * bg-destructive / bg-status-warning fill with white text fails AA in dark
 * mode, where the status fills are light.
 */
export const HEALTH_BANNER_TONE = {
  offline: {
    banner: "bg-status-critical/12 border-status-critical/30",
    accent: "text-status-critical",
    dot: "bg-status-critical",
  },
  degraded: {
    banner: "bg-status-warning/12 border-status-warning/30",
    accent: "text-status-warning",
    dot: "bg-status-warning",
  },
} as const;

/** Where "View status" leads: the server's own processes, with Restart. */
export const HEALTH_STATUS_HREF = "/dashboard/settings#services";

/**
 * "14:02" today, "29 Sep, 23:40" on another day: a bare time after
 * midnight would point at the wrong day.
 */
export function formatHealthSince(since: string | null | undefined, now = Date.now()): string | null {
  if (!since) return null;
  const date = new Date(since);
  if (!Number.isFinite(date.getTime())) return null;
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

export interface HealthBannerCopy {
  title: string;
  detail: string;
  /**
   * The server itself can't be reached (offline, or network failures not yet
   * counted as offline): offer Retry, never the Assistant, which runs there.
   */
  unreachable: boolean;
}

/** The words for a server that isn't healthy: what is wrong, in the person's terms, since when, and the fix. */
export function healthBannerCopy(
  status: Exclude<OnlineStatus, "online">,
  checks: Record<string, "ok" | "error"> = {},
  since?: string | null,
  reachable = true,
  now = Date.now(),
): HealthBannerCopy {
  const at = formatHealthSince(since, now);
  if (status === "offline" || !reachable) {
    return {
      title: `Talome can't reach its server${at ? ` since ${at}` : ""}`,
      detail: "Check that the Talome server is running. Talome keeps retrying.",
      unreachable: true,
    };
  }
  const failing = failingChecksLabel(checks);
  if (failing) {
    return {
      title: at ? `${capitalize(failing)} hasn't responded since ${at}` : `${capitalize(failing)} isn't responding`,
      detail: "Apps may not start, stop or update until this is fixed. Check the status, or ask Talome to diagnose it.",
      unreachable: false,
    };
  }
  return {
    title: `Talome's server reported a problem${at ? ` at ${at}` : ""}`,
    detail: "Apps may not start, stop or update until this is fixed. Check the status, or ask Talome to diagnose it.",
    unreachable: false,
  };
}

/** The prompt "Diagnose with Talome" puts in the Assistant, for the person to send. */
export function diagnosePrompt(checks: Record<string, "ok" | "error"> = {}): string {
  const failing = failingChecksLabel(checks);
  return (
    `The Talome server is degraded${failing ? `: ${failing} isn't responding` : ""}. ` +
    "Diagnose what's wrong and suggest how to fix it. Ask before changing anything."
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function SystemHealthBanner() {
  const { status, checks, since, reachable, recheck } = useIsOnline();
  const { isAdmin, hasPermission } = useUser();

  if (status === "online") return null;

  const copy = healthBannerCopy(status, checks, since, reachable !== false);
  const unreachable = copy.unreachable;
  const tone = unreachable ? HEALTH_BANNER_TONE.offline : HEALTH_BANNER_TONE.degraded;
  // The Assistant runs on the same server: offer it only while that server answers.
  const canDiagnose = !unreachable && hasPermission("chat");

  return (
    <Banner
      key={unreachable ? "unreachable" : "degraded"}
      className={cn(
        "text-foreground rounded-none border-b motion-safe:animate-in motion-safe:fade-in-80",
        tone.banner,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <BannerIcon
          icon={unreachable ? AlertCircleIcon : Alert02Icon}
          aria-hidden="true"
          className={cn("border-current/20 bg-transparent shadow-none", tone.accent)}
        />
        {/* Only the words are announced; the buttons are not part of the live region. */}
        <div role="status" className="min-w-0">
          <BannerTitle className="text-sm font-medium">{copy.title}</BannerTitle>
          <p className="text-xs text-foreground">{copy.detail}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {unreachable ? (
          <Button variant="ghost" size="sm" className="h-7 text-foreground hover:bg-foreground/10" onClick={() => recheck?.()}>
            Retry
          </Button>
        ) : null}
        {canDiagnose ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-foreground hover:bg-foreground/10"
            onClick={() => openPalette({ mode: "chat", prefill: diagnosePrompt(checks) })}
          >
            Diagnose with Talome
          </Button>
        ) : null}
        {!unreachable && isAdmin ? (
          <Button variant="ghost" size="sm" className="h-7 text-foreground hover:bg-foreground/10" asChild>
            <Link href={HEALTH_STATUS_HREF}>View status</Link>
          </Button>
        ) : null}
        <BannerClose
          aria-label="Dismiss system health banner"
          className="size-7 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        />
      </div>
    </Banner>
  );
}
