"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { toastWarning } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  HugeiconsIcon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
} from "@/components/icons";
import { relativeTime } from "@/components/settings/settings-primitives";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { talomePost } from "@/hooks/use-talome-api";
import {
  CHECK_STATUS_LABELS,
  VERIFICATION_STATUS_LABELS,
  checkTone,
  parseVerificationResponse,
  sortChecks,
  verificationTone,
  type VerificationResult,
  type VerificationStatus,
} from "@/lib/verification";
import { TONE_DOT, TONE_TEXT } from "./tone";

type VerificationTarget = "app" | "stack";

/** `unsupported` = no outcome probe exists for this app/stack (404). */
type VerificationState = { kind: "unsupported" } | { kind: "ok"; result: VerificationResult | null };

async function verificationFetcher(url: string): Promise<VerificationState> {
  const res = await fetch(url, { credentials: "include" });
  if (res.status === 404) return { kind: "unsupported" };
  if (!res.ok) throw new Error(`Failed to load verification (${res.status})`);
  return { kind: "ok", result: parseVerificationResponse(await res.json()) };
}

export function verificationUrl(target: VerificationTarget, id: string): string {
  return `${CORE_URL}/api/verification/${target === "app" ? "apps" : "stacks"}/${encodeURIComponent(id)}`;
}

function StatusIcon({ status }: { status: VerificationStatus }) {
  if (status === "verified") return <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} />;
  if (status === "unknown") return <HugeiconsIcon icon={Clock01Icon} size={14} />;
  return <HugeiconsIcon icon={AlertCircleIcon} size={14} />;
}

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", TONE_TEXT[verificationTone(status)])}>
      <StatusIcon status={status} />
      {VERIFICATION_STATUS_LABELS[status]}
    </span>
  );
}

function CheckRow({ check }: { check: VerificationResult["checks"][number] }) {
  const tone = checkTone(check.status);
  const showRemediation = !!check.remediation && check.status !== "pass" && check.status !== "skip";
  return (
    <div className="px-4 py-3 grid gap-1">
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} aria-hidden />
        <p className="flex-1 min-w-0 text-sm">{check.label}</p>
        <span className={cn("shrink-0 text-xs", TONE_TEXT[tone])}>{CHECK_STATUS_LABELS[check.status]}</span>
      </div>
      {check.evidence && (
        <p className="pl-4 text-xs text-muted-foreground break-words">{check.evidence}</p>
      )}
      {showRemediation && (
        <p className="pl-4 text-xs text-foreground/80 break-words">
          <span className="text-muted-foreground">Fix: </span>
          {check.remediation}
        </p>
      )}
    </div>
  );
}

/**
 * Outcome verification for an app or stack: status badge, the checks with
 * evidence and remediation, and a "Verify now" action. Renders nothing when
 * Talome has no outcome probe for the target.
 */
export function VerificationPanel({
  target,
  id,
  enabled = true,
}: {
  target: VerificationTarget;
  id: string;
  enabled?: boolean;
}) {
  const key = enabled && id ? verificationUrl(target, id) : null;
  const { data, error, mutate } = useSWR<VerificationState>(key, verificationFetcher, {
    revalidateOnFocus: false,
  });
  const [running, setRunning] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);

  if (!key || !data || data.kind === "unsupported") {
    if (error && key) {
      return (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Verification</h2>
          <p className="text-sm text-muted-foreground">Couldn&apos;t load verification results.</p>
        </section>
      );
    }
    return null;
  }

  const result = data.result;
  const status: VerificationStatus = result?.status ?? "unknown";
  const checks = sortChecks(result?.checks ?? []);
  // Expanded by default when something needs attention.
  const open = detailsOpen ?? (status === "failed" || status === "degraded");

  const runVerification = async () => {
    setRunning(true);
    try {
      const body = target === "app" ? { appId: id } : { stackId: id };
      const response = await talomePost<unknown>("/api/verification/run", body);
      const fresh = parseVerificationResponse(response);
      await mutate({ kind: "ok", result: fresh }, { revalidate: false });
      if (fresh) {
        const label = VERIFICATION_STATUS_LABELS[fresh.status];
        if (fresh.status === "verified") toast.success(`${label}: ${fresh.summary || "everything checks out"}`);
        else toastWarning(`${label}`, { description: fresh.summary || undefined });
      }
    } catch (err) {
      toast.error("Verification failed to run", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="grid gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Verification</h2>
      <div className="rounded-xl border border-border divide-y divide-border">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0 grid gap-0.5">
            <VerificationBadge status={status} />
            <p className="text-xs text-muted-foreground">
              {result
                ? `${result.summary ? `${result.summary} · ` : ""}Checked ${relativeTime(result.verifiedAt)}`
                : "Talome hasn't checked that this works end to end yet."}
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 shrink-0" onClick={runVerification} disabled={running}>
            {running && <Spinner className="size-3.5" />}
            {running ? "Verifying..." : "Verify now"}
          </Button>
        </div>

        {result?.chain && result.chain.length > 0 && (
          <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {result.chain.map((link, i) => (
              <span key={link.id} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                {i > 0 && <HugeiconsIcon icon={ArrowRight01Icon} size={10} className="text-dim-foreground" />}
                <span className={cn("size-1.5 rounded-full", TONE_DOT[checkTone(link.status)])} aria-hidden />
                {link.label}
              </span>
            ))}
          </div>
        )}

        {checks.length > 0 && (
          <Collapsible open={open} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
                {open ? "Hide checks" : `Show ${checks.length} check${checks.length === 1 ? "" : "s"}`}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="divide-y divide-border border-t border-border">
                {checks.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </section>
  );
}
