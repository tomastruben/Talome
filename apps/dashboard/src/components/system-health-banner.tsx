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

function formatSince(since: string | null | undefined): string | null {
  if (!since) return null;
  const date = new Date(since);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export interface HealthBannerCopy {
  title: string;
  detail: string;
}

/** The banner's words: what is wrong, in the person's terms, and since when. */
export function healthBannerCopy(
  status: Exclude<OnlineStatus, "online">,
  checks: Record<string, "ok" | "error"> = {},
  since?: string | null,
): HealthBannerCopy {
  const at = formatSince(since);
  const sinceText = at ? ` since ${at}` : "";
  if (status === "offline") {
    return {
      title: `Talome can't reach its server${sinceText}`,
      detail: "Check that the Talome server is running. Talome keeps retrying.",
    };
  }
  const failing = failingChecksLabel(checks);
  return {
    title: failing ? `${capitalize(failing)} isn't responding${sinceText}` : `Talome is running with problems${sinceText}`,
    detail: "Apps may not start, stop or update until this is fixed.",
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
  const { status, checks, since, recheck } = useIsOnline();
  const { isAdmin, hasPermission } = useUser();

  if (status === "online") return null;

  const isOffline = status === "offline";
  const tone = isOffline ? HEALTH_BANNER_TONE.offline : HEALTH_BANNER_TONE.degraded;
  const copy = healthBannerCopy(status, checks, since);
  // The Assistant runs on the same server: offer it only while that server answers.
  const canDiagnose = !isOffline && hasPermission("chat");

  return (
    <Banner
      key={status}
      role="status"
      className={cn(
        "text-foreground rounded-none border-b motion-safe:animate-in motion-safe:fade-in-80",
        tone.banner,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <BannerIcon
          icon={isOffline ? AlertCircleIcon : Alert02Icon}
          aria-hidden="true"
          className={cn("border-current/20 bg-transparent shadow-none", tone.accent)}
        />
        <div className="min-w-0">
          <BannerTitle className="text-sm font-medium">{copy.title}</BannerTitle>
          <p className="text-xs text-foreground">{copy.detail}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isOffline ? (
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
        {!isOffline && isAdmin ? (
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
