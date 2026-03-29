"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  HugeiconsIcon,
  CheckmarkCircle01Icon,
  AlertCircleIcon,
  FileEditIcon,
  Cancel01Icon,
  ArrowDown01Icon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import type { CompleteResult } from "./evolution-terminal";

interface ExecutionResultProps {
  result: CompleteResult;
  runId?: string;
  onBack: () => void;
}

function durationLabel(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// ── Diff Viewer ──────────────────────────────────────────────────────────────

function DiffLine({ line }: { line: string }) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return <span className="text-[oklch(0.723_0.191_149.58)]/80">{line}</span>;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return <span className="text-[oklch(0.704_0.191_22.216)]/80">{line}</span>;
  }
  if (line.startsWith("@@")) {
    return <span className="text-[oklch(0.6_0.15_250)]/60">{line}</span>;
  }
  if (line.startsWith("diff ") || line.startsWith("index ")) {
    return <span className="text-muted-foreground">{line}</span>;
  }
  return <span className="text-muted-foreground">{line}</span>;
}

function DiffViewer({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split("\n");
  const displayLines = expanded ? lines : lines.slice(0, 30);
  const hasMore = lines.length > 30;

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <HugeiconsIcon icon={FileEditIcon} size={10} />
        Diff
      </p>
      <pre className="text-xs bg-muted/20 rounded-lg p-3 overflow-x-auto max-h-80 leading-relaxed font-mono">
        {displayLines.map((line, i) => (
          <div key={i}><DiffLine line={line} /></div>
        ))}
      </pre>
      {hasMore && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs text-dim-foreground hover:text-muted-foreground flex items-center gap-1 transition-colors"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={10} />
          Show {lines.length - 30} more lines
        </button>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function ExecutionResult({ result, runId, onBack }: ExecutionResultProps) {
  const success = result.ok && !result.rolledBack;
  const [diff, setDiff] = useState<string | null>(null);

  // Fetch diff from run record if available
  useEffect(() => {
    if (!runId || !success) return;

    fetch(`${CORE_URL}/api/evolution/runs/${runId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.diffOutput) setDiff(data.diffOutput);
      })
      .catch(() => {});
  }, [runId, success]);

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 flex flex-col max-h-[calc(100svh-10rem)] overflow-hidden">
      {/* Sticky header — always visible with back button */}
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6 sm:py-4 border-b border-border/40 shrink-0">
        {success ? (
          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={20} className="text-[oklch(0.723_0.191_149.58)]" />
        ) : (
          <HugeiconsIcon icon={AlertCircleIcon} size={20} className="text-[oklch(0.704_0.191_22.216)]" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {success ? "Changes applied successfully" : result.rolledBack ? "Changes rolled back" : "Execution failed"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {durationLabel(result.duration)}
            {result.rolledBack && " — TypeScript errors detected, auto-reverted via git stash"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0 text-muted-foreground">
          <HugeiconsIcon icon={Cancel01Icon} size={14} className="mr-1" />
          Dismiss
        </Button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {result.filesChanged.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
              <HugeiconsIcon icon={FileEditIcon} size={10} />
              {result.filesChanged.length} file{result.filesChanged.length !== 1 ? "s" : ""} changed
            </p>
            <div className="flex flex-wrap gap-1 min-w-0">
              {result.filesChanged.map((f) => (
                <code
                  key={f}
                  className="text-xs bg-muted rounded px-1.5 py-0.5 font-mono text-muted-foreground max-w-full break-all"
                >
                  {f}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* Visual diff */}
        {diff && <DiffViewer diff={diff} />}

        {result.typeErrors && (
          <div>
            <p className="text-xs text-destructive/80 mb-1.5">Type errors</p>
            <pre className="text-xs bg-destructive/8 rounded-lg p-2.5 overflow-x-auto max-h-32 text-destructive/80 leading-relaxed">
              {result.typeErrors.slice(0, 800)}
            </pre>
          </div>
        )}

        {result.stashMessage && (
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Badge variant="secondary" className="text-xs font-mono max-w-full truncate">
              {result.stashMessage}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Inspect with: git stash show -p
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
