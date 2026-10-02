"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { HugeiconsIcon, CpuIcon, LayoutGridIcon, ComputerTerminal01Icon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useUser } from "@/hooks/use-user";
import { CORE_URL } from "@/lib/constants";
import { parseOperationHistory } from "@/lib/app-operations";
import {
  SERVICE_LABELS,
  describeOperation,
  inFlightConsequence,
  inFlightScope,
  processDotState,
  runVerifiedRestart,
  type InFlightScope,
  type InFlightWork,
  type SupervisedService,
  type SupervisorState,
} from "@/lib/service-restart";

const STATUS_URL = `${CORE_URL}/api/supervisor/status`;

async function readSupervisorStatus(): Promise<SupervisorState | null> {
  const res = await fetch(STATUS_URL, { credentials: "include", cache: "no-store" });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as SupervisorState | null;
  return body && typeof body === "object" && body.processes ? body : null;
}

async function statusFetcher(): Promise<SupervisorState | null> {
  return readSupervisorStatus();
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * Work a restart of this service would interrupt: core's work (app
 * operations, self-improvement runs, the Assistant's reply) for core, open
 * terminal sessions for the terminal daemon. A failed check is reported as
 * unknown, never as "nothing".
 */
async function readInFlightWork(scope: InFlightScope, isAdmin: boolean, assistantReplying: boolean): Promise<InFlightWork> {
  const work: InFlightWork = {
    operations: [],
    evolutionRuns: 0,
    assistantReplying: scope.core && assistantReplying,
    terminalSessions: [],
    unknown: false,
  };
  const [ops, evolution, sessions] = await Promise.allSettled([
    scope.core
      ? getJson(`${CORE_URL}/api/operations?active=1&limit=50`).then(parseOperationHistory)
      : Promise.resolve([]),
    scope.core && isAdmin
      ? getJson(`${CORE_URL}/api/evolution/suggestions?status=in_progress`).then((body) => {
          const suggestions = (body as { suggestions?: unknown }).suggestions;
          return Array.isArray(suggestions) ? suggestions.length : 0;
        })
      : Promise.resolve(0),
    scope.terminal
      ? getJson(`${CORE_URL}/api/terminal/sessions`).then((body) => {
          const list = (body as { sessions?: unknown }).sessions;
          if (!Array.isArray(list)) throw new Error("Unexpected sessions response");
          return list.map((raw) => {
            const session = raw as { id?: unknown; name?: unknown; displayName?: unknown };
            const label = [session.displayName, session.name, session.id].find((v) => typeof v === "string" && v);
            return String(label ?? "session");
          });
        })
      : Promise.resolve([]),
  ]);
  if (ops.status === "fulfilled") work.operations = ops.value.map(describeOperation);
  else work.unknown = true;
  if (evolution.status === "fulfilled") work.evolutionRuns = evolution.value;
  else work.unknown = true;
  if (sessions.status === "fulfilled") work.terminalSessions = sessions.value;
  else work.unknown = true;
  return work;
}

const SERVICES: Array<{ key: SupervisedService; desc: string; icon: IconSvgElement }> = [
  { key: "core", desc: "API, AI agent, Docker, media", icon: CpuIcon },
  { key: "dashboard", desc: "Web interface", icon: LayoutGridIcon },
  { key: "terminal_daemon", desc: "Shell sessions, Claude Code", icon: ComputerTerminal01Icon },
];

/**
 * Settings → Services: the server's own processes, each with Restart.
 * A restart confirms first when it would interrupt running work, checks the
 * response, and waits for the supervisor to report the process healthy under
 * a new pid before saying it is done.
 */
export function ServicesSection({ heading }: { heading: React.ReactNode }) {
  const { data: state, error: statusError, isLoading, mutate } = useSWR<SupervisorState | null>(STATUS_URL, statusFetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: false,
  });
  /** "checking" while the in-flight check runs, then the service being restarted. */
  const [pending, setPending] = useState<{ service: SupervisedService | "all"; phase: "checking" | "restarting" } | null>(null);
  // A synchronous guard: a double click lands before the state update renders.
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const { isAdmin } = useUser();
  const { status: assistantStatus } = useAssistant();
  const assistantReplying = assistantStatus === "streaming" || assistantStatus === "submitted";
  const sectionRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Polling stops when Settings is left: no state updates or toasts from a dead page.
  useEffect(() => () => abortRef.current?.abort(), []);

  // "View status" links here (/dashboard/settings#services). The section's
  // content arrives after the page, so Next's hash scroll can miss it.
  const loaded = state !== undefined || statusError !== undefined;
  useEffect(() => {
    if (loaded && window.location.hash === "#services") {
      sectionRef.current?.scrollIntoView({ block: "start" });
    }
  }, [loaded]);

  const restart = useCallback(async (service: SupervisedService | "all") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setPending({ service, phase: "checking" });
    try {
      const work = await readInFlightWork(inFlightScope(service), isAdmin, assistantReplying);
      const consequence = inFlightConsequence(work, service);
      if (consequence) {
        const label = service === "all" ? "every service" : SERVICE_LABELS[service];
        const { confirmed } = await confirm({
          tier: "soft",
          title: `Restart ${label} now?`,
          consequence,
          recovery: "Nothing is deleted. Interrupted app operations are recovered or rolled back when Talome starts again.",
          confirmLabel: service === "all" ? "Restart all services" : `Restart ${SERVICE_LABELS[service]}`,
        });
        if (!confirmed) return;
      }

      setPending({ service, phase: "restarting" });
      const controller = new AbortController();
      abortRef.current = controller;
      const before = state ?? (await readSupervisorStatus().catch(() => null));
      const outcome = await runVerifiedRestart(service, before, {
        request: (target) => fetch(`${CORE_URL}/api/supervisor/restart`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service: target }),
        }),
        readStatus: readSupervisorStatus,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        signal: controller.signal,
      });
      if (outcome.ok === false && outcome.reason === "cancelled") return;
      void mutate();

      const name = service === "all" ? "all services" : SERVICE_LABELS[service];
      if (outcome.ok) {
        toast.success(`Restarted ${name} · verified healthy`);
      } else if (outcome.reason === "timeout") {
        setError(`Couldn't confirm that ${name} came back. Check the status below, or retry.`);
      } else if (outcome.reason === "request") {
        setError(outcome.error);
      }
    } finally {
      busyRef.current = false;
      setPending(null);
    }
  }, [assistantReplying, confirm, isAdmin, mutate, state]);

  const restarting = pending?.phase === "restarting" ? pending.service : null;
  const checking = pending?.phase === "checking" ? pending.service : null;

  return (
    <section id="services" ref={sectionRef} className="scroll-mt-16">
      {heading}
      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
        {!state?.processes ? (
          <div className="px-4 py-3.5 flex items-center gap-3">
            {isLoading ? (
              <p className="flex-1 text-sm text-muted-foreground">Checking status…</p>
            ) : (
              <>
                <p className="flex-1 text-sm text-muted-foreground">
                  Status unavailable · Talome&apos;s supervisor isn&apos;t running, so services can&apos;t be restarted from here.
                </p>
                <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => void mutate()}>Retry</Button>
              </>
            )}
          </div>
        ) : (
          <>
            {SERVICES.map((s) => {
              // This page is served by the dashboard, so it is up while you read it.
              const proc = s.key === "dashboard" ? state.processes.dashboard ?? { pid: null, status: "healthy" } : state.processes[s.key];
              const isRestarting = restarting === s.key || restarting === "all";
              const isChecking = checking === s.key;
              const dot = isRestarting ? { state: "working" as const, label: "Restarting…" } : processDotState(proc);
              return (
                <div key={s.key} className="px-4 py-3.5 flex items-center gap-3">
                  <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0" aria-hidden="true">
                    <HugeiconsIcon icon={s.icon} size={16} className="text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{SERVICE_LABELS[s.key]}</p>
                    <p className="text-xs text-muted-foreground">{s.desc}</p>
                  </div>
                  <StatusDot state={dot.state} label={dot.label} size="md" className="shrink-0 [&>span:last-child]:text-xs [&>span:last-child]:text-muted-foreground" />
                  <Button
                    variant="ghost"
                    size="sm"
                    busy={isRestarting || isChecking}
                    busyLabel={isChecking ? "Checking…" : `Restarting ${SERVICE_LABELS[s.key]}…`}
                    disabled={pending !== null && !isRestarting && !isChecking}
                    onClick={() => void restart(s.key)}
                  >
                    Restart
                  </Button>
                </div>
              );
            })}
            {error ? (
              <p role="alert" className="px-4 py-2.5 text-sm text-status-critical">{error}</p>
            ) : null}
            <div className="px-4 py-2.5 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                busy={restarting === "all" || checking === "all"}
                busyLabel={checking === "all" ? "Checking…" : "Restarting all services…"}
                disabled={pending !== null && pending.service !== "all"}
                onClick={() => void restart("all")}
              >
                Restart all services
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
