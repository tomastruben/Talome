"use client";

import { useCallback, useState } from "react";
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
  processDotState,
  runVerifiedRestart,
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

/** Work a restart would interrupt. A failed check is reported as unknown, never as "nothing". */
async function readInFlightWork(isAdmin: boolean, assistantReplying: boolean): Promise<InFlightWork> {
  const work: InFlightWork = { operations: [], evolutionRuns: 0, assistantReplying, unknown: false };
  const [ops, evolution] = await Promise.allSettled([
    fetch(`${CORE_URL}/api/operations?active=1&limit=50`, { credentials: "include", cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      return parseOperationHistory(await res.json());
    }),
    isAdmin
      ? fetch(`${CORE_URL}/api/evolution/suggestions?status=in_progress`, { credentials: "include", cache: "no-store" }).then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const body = await res.json() as { suggestions?: unknown };
          return Array.isArray(body.suggestions) ? body.suggestions.length : 0;
        })
      : Promise.resolve(0),
  ]);
  if (ops.status === "fulfilled") work.operations = ops.value.map(describeOperation);
  else work.unknown = true;
  if (evolution.status === "fulfilled") work.evolutionRuns = evolution.value;
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
  const { data: state, mutate } = useSWR<SupervisorState | null>(STATUS_URL, statusFetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: false,
  });
  const [restarting, setRestarting] = useState<SupervisedService | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const { isAdmin } = useUser();
  const { status: assistantStatus } = useAssistant();
  const assistantReplying = assistantStatus === "streaming" || assistantStatus === "submitted";

  const restart = useCallback(async (service: SupervisedService | "all") => {
    setError(null);
    const work = await readInFlightWork(isAdmin, assistantReplying);
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

    setRestarting(service);
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
    });
    setRestarting(null);
    void mutate();

    const name = service === "all" ? "all services" : SERVICE_LABELS[service];
    if (outcome.ok) {
      toast.success(`Restarted ${name} · verified running`);
    } else if (outcome.reason === "timeout") {
      setError(`Couldn't confirm that ${name} came back. Check the status below, or retry.`);
    } else {
      setError(outcome.error);
    }
  }, [assistantReplying, confirm, isAdmin, mutate, state]);

  if (!state?.processes) return null;

  return (
    <section id="services" className="scroll-mt-16">
      {heading}
      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
        {SERVICES.map((s) => {
          // This page is served by the dashboard, so it is up while you read it.
          const proc = s.key === "dashboard" ? state.processes.dashboard ?? { pid: null, status: "healthy" } : state.processes[s.key];
          const isRestarting = restarting === s.key || restarting === "all";
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
                busy={isRestarting}
                busyLabel={`Restarting ${SERVICE_LABELS[s.key]}…`}
                disabled={restarting !== null && !isRestarting}
                onClick={() => void restart(s.key)}
              >
                Restart
              </Button>
            </div>
          );
        })}
        {error ? (
          <p role="alert" className="px-4 py-2.5 text-xs text-status-critical">{error}</p>
        ) : null}
        <div className="px-4 py-2.5 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            busy={restarting === "all"}
            busyLabel="Restarting all services…"
            disabled={restarting !== null && restarting !== "all"}
            onClick={() => void restart("all")}
          >
            Restart all services
          </Button>
        </div>
      </div>
    </section>
  );
}
