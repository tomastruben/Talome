"use client";

import { useState, useEffect } from "react";
import {
  HugeiconsIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Database01Icon,
  Shield01Icon,
  CheckmarkCircle02Icon,
  Settings01Icon,
  PackageOpenIcon,
  ComputerTerminal01Icon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BlueprintIdentity {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
}

export interface BlueprintService {
  name: string;
  image: string;
  ports: Array<{ host: number; container: number }>;
  volumes: Array<{ hostPath: string; containerPath: string }>;
  environment: Record<string, string>;
  healthcheck?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
}

export interface BlueprintEnvVar {
  key: string;
  label: string;
  required: boolean;
  default?: string;
  secret?: boolean;
}

export interface BlueprintScaffold {
  enabled: boolean;
  kind: string;
  framework?: string;
}

export interface BlueprintState {
  identity?: BlueprintIdentity;
  services?: BlueprintService[];
  env?: BlueprintEnvVar[];
  scaffold?: BlueprintScaffold;
  criteria?: string[];
}

// ── Readiness ───────────────────────────────────────────────────────────────

interface ReadinessCheck {
  label: string;
  met: boolean;
}

function getReadiness(bp: BlueprintState): { checks: ReadinessCheck[]; ready: boolean } {
  const checks: ReadinessCheck[] = [
    { label: "Identity", met: !!bp.identity?.name },
    { label: "Services", met: (bp.services?.length ?? 0) > 0 },
    { label: "Criteria", met: (bp.criteria?.length ?? 0) > 0 },
  ];
  return { checks, ready: checks.every((c) => c.met) };
}

// ── Expanded detail ─────────────────────────────────────────────────────────

function ExpandedDetail({ blueprint }: { blueprint: BlueprintState }) {
  return (
    <div className="grid gap-3 px-4 pb-4 pt-2">
      {/* Services */}
      {blueprint.services && blueprint.services.length > 0 && (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            <HugeiconsIcon icon={Database01Icon} size={10} />
            Services
          </div>
          {blueprint.services.map((svc) => (
            <div key={svc.name} className="rounded-lg bg-muted/20 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">{svc.name}</span>
                <span className="text-xs text-muted-foreground font-mono truncate">{svc.image}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                {svc.ports.length > 0 && (
                  <span>{svc.ports.map((p) => `${p.host}:${p.container}`).join(", ")}</span>
                )}
                {svc.volumes.length > 0 && (
                  <span>{svc.volumes.length} vol{svc.volumes.length !== 1 ? "s" : ""}</span>
                )}
                {Object.keys(svc.environment).length > 0 && (
                  <span>{Object.keys(svc.environment).length} env</span>
                )}
                {svc.healthcheck && <span>healthcheck</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Env vars */}
      {blueprint.env && blueprint.env.length > 0 && (
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            <HugeiconsIcon icon={Settings01Icon} size={10} />
            Environment
          </div>
          {blueprint.env.map((v) => (
            <div key={v.key} className="flex items-center gap-2 text-xs px-1">
              <span className="font-mono text-muted-foreground">{v.key}</span>
              {v.secret && <HugeiconsIcon icon={Shield01Icon} size={9} className="text-dim-foreground" />}
              {v.default ? (
                <span className="text-muted-foreground truncate ml-auto">= {v.default}</span>
              ) : v.required ? (
                <span className="text-destructive/50 ml-auto text-xs">required</span>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Criteria */}
      {blueprint.criteria && blueprint.criteria.length > 0 && (
        <div className="grid gap-1">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={10} />
            Success Criteria
          </div>
          {blueprint.criteria.map((c, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground px-1">
              <span className="text-dim-foreground mt-px">-</span>
              <span className="leading-relaxed">{c}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export function BlueprintDraftBar({
  blueprint,
  onBuild,
  building,
  onDismiss,
  auto: autoMode,
  onAutoChange,
}: {
  blueprint: BlueprintState;
  onBuild: () => void;
  building?: boolean;
  onDismiss: () => void;
  auto: boolean;
  onAutoChange: (value: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { checks, ready } = getReadiness(blueprint);
  const metCount = checks.filter((c) => c.met).length;

  const name = blueprint.identity?.name;
  const icon = blueprint.identity?.icon;
  const servicesSummary = blueprint.services
    ?.map((s) => s.image.split(":")[0].split("/").pop())
    .join(" · ");

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 backdrop-blur-sm overflow-hidden">
      {/* Collapsed bar */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Icon + name */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {icon ? (
            <span className="text-base leading-none shrink-0">{icon}</span>
          ) : (
            <HugeiconsIcon icon={PackageOpenIcon} size={16} className="text-dim-foreground shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground truncate">
              {name || "New App"}
            </p>
            {servicesSummary && (
              <p className="text-xs text-muted-foreground truncate">{servicesSummary}</p>
            )}
          </div>
        </div>

        {/* Readiness dots */}
        <div className="flex items-center gap-1.5 shrink-0">
          {checks.map((c) => (
            <span
              key={c.label}
              title={c.label}
              className={`size-1.5 rounded-full transition-colors ${c.met ? "bg-status-healthy/70" : "bg-muted-foreground/20"}`}
            />
          ))}
          <span className="text-xs text-muted-foreground tabular-nums ml-0.5">
            {metCount}/{checks.length}
          </span>
        </div>

        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center size-7 rounded-md text-dim-foreground hover:text-muted-foreground hover:bg-muted/20 transition-colors shrink-0"
        >
          <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowUp01Icon} size={14} />
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && <ExpandedDetail blueprint={blueprint} />}

      {/* Auto mode toggle + Build button */}
      <div className="px-4 pb-3 space-y-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onAutoChange(!autoMode)}
            className={cn(
              "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
              autoMode ? "bg-status-warning" : "bg-input"
            )}
          >
            <span
              className={cn(
                "inline-block size-3 rounded-full bg-white transition-transform",
                autoMode ? "translate-x-3.5" : "translate-x-0.5"
              )}
            />
          </button>
          <span className="text-xs text-muted-foreground">
            Auto
          </span>
          <span className="text-xs text-muted-foreground">
            — skip approvals
          </span>
        </div>
        <button
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-15 disabled:cursor-not-allowed"
          disabled={!ready || building}
          onClick={onBuild}
        >
          {building ? (
            <>
              <Spinner className="size-3.5" />
              Building...
            </>
          ) : (
            <>
              <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} />
              Build with Claude Code
            </>
          )}
        </button>
      </div>
    </div>
  );
}
