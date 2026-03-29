"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
/** html-to-image loaded on demand — only needed when user triggers a screenshot */
const loadToPng = () => import("html-to-image").then((m) => m.toPng);
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  HugeiconsIcon,
  Bug01Icon,
  BulbChargingIcon,
  CenterFocusIcon,
  ImageAdd01Icon,
  PlayIcon,
  Cancel01Icon,
  Edit02Icon,
  AiSearch02Icon,
  AlertCircleIcon,
  Wifi01Icon,
  CheckmarkCircle01Icon,
} from "@/components/icons";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useBugHunt } from "./bug-hunt-context";
import { useBugContext, type BugContext } from "@/hooks/use-bug-context";
import { EvolutionTerminal, type CompleteResult } from "@/app/dashboard/evolution/components/evolution-terminal";
import { ExecutionResult } from "@/app/dashboard/evolution/components/execution-result";

// ── Types ────────────────────────────────────────────────────────────────────

interface AugmentedBug {
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  category: string;
  scope: string;
  priority: string;
  taskPrompt: string;
}

interface ExecutionData {
  runId: string;
  sessionName: string;
  command: string;
  taskPrompt: string;
  scope: string;
}

type Phase = "report" | "augmented" | "executing" | "result";

const priorityColor: Record<string, string> = {
  low: "text-muted-foreground",
  medium: "text-status-warning",
  high: "text-status-critical",
};

/** Icon for AI-classified category in the augmented phase */
function categoryVisual(cat: string): { icon: typeof Bug01Icon; color: string; bg: string } {
  if (cat === "feature") return { icon: BulbChargingIcon, color: "text-status-warning", bg: "bg-status-warning/10" };
  return { icon: Bug01Icon, color: "text-status-critical", bg: "bg-status-critical/10" };
}

// ── Overlay ──────────────────────────────────────────────────────────────────

export function BugHuntOverlay() {
  const { isOpen, close, screenshot: initialScreenshot, context: initialContext, mode } = useBugHunt();
  const { captureContext } = useBugContext();

  const [phase, setPhase] = useState<Phase>("report");
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [capturedCtx, setCapturedCtx] = useState<BugContext | null>(null);
  const [augmenting, setAugmenting] = useState(false);
  const [augmented, setAugmented] = useState<AugmentedBug | null>(null);
  const [screenshotPaths, setScreenshotPaths] = useState<string[]>([]);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionData | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [selectedSignals, setSelectedSignals] = useState<Set<string>>(new Set());
  const [signalsExpanded, setSignalsExpanded] = useState(false);
  const [autoMode, setAutoMode] = useState(false);

  // Sync auto mode from localStorage after hydration to avoid SSR mismatch
  useEffect(() => {
    setAutoMode(localStorage.getItem("talome-auto-mode") === "true");
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Build signal list from context ──────────────────────────────────

  const allSignals = capturedCtx ? [
    ...capturedCtx.consoleErrors.map((e, i) => ({
      id: `console-${i}`,
      type: e.level as "error" | "warn" | "network",
      label: e.message.slice(0, 120),
    })),
    ...capturedCtx.networkErrors.map((e, i) => ({
      id: `net-${i}`,
      type: "network" as const,
      label: `${e.method} ${e.url} → ${e.status}`,
    })),
  ] : [];

  // Auto-select all signals initially when context arrives
  useEffect(() => {
    if (capturedCtx && selectedSignals.size === 0 && allSignals.length > 0) {
      setSelectedSignals(new Set(allSignals.map((s) => s.id)));
    }
  }, [capturedCtx]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSignal = useCallback((id: string) => {
    setSelectedSignals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllSignals = useCallback(() => {
    setSelectedSignals(new Set(allSignals.map((s) => s.id)));
  }, [allSignals]);

  const deselectAllSignals = useCallback(() => {
    setSelectedSignals(new Set());
  }, []);

  // ── Sync initial data from context ─────────────────────────────────

  useEffect(() => {
    if (isOpen) {
      setScreenshot(initialScreenshot);
      setCapturedCtx(initialContext);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [isOpen, initialScreenshot, initialContext]);

  // ── Screenshot capture ──────────────────────────────────────────────

  const captureScreenshot = useCallback(async () => {
    try {
      const target = document.querySelector("main") as HTMLElement | null ?? document.body;
      const toPng = await loadToPng();
      const dataUrl = await toPng(target, {
        quality: 0.8,
        pixelRatio: 1,
        filter: (node: HTMLElement) => !node.dataset?.bugHuntOverlay,
      });
      setScreenshot(dataUrl);
      if (!capturedCtx) setCapturedCtx(captureContext());
    } catch {
      // Silent
    }
  }, [capturedCtx, captureContext]);

  // ── Global keyboard shortcut: Cmd+Shift+X ─────────────────────────

  const bugHuntMethods = useBugHunt();
  const bugHuntRef = useRef(bugHuntMethods);
  bugHuntRef.current = bugHuntMethods;

  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x") {
        e.preventDefault();

        if (isOpen) {
          await captureScreenshot();
          return;
        }

        // Capture BEFORE opening so overlay isn't in the screenshot
        let screenshotData: string | null = null;
        try {
          const target = document.querySelector("main") as HTMLElement | null ?? document.body;
          const toPngFn = await loadToPng();
          screenshotData = await toPngFn(target, { quality: 0.8, pixelRatio: 1 });
        } catch {
          // Silent fail — screenshot is optional
        }

        const ctx = captureContext();
        bugHuntRef.current.open({ screenshot: screenshotData ?? undefined, context: ctx });
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, captureContext, captureScreenshot]);

  // ── Manual screenshot upload ───────────────────────────────────────

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setScreenshot(reader.result as string);
      if (!capturedCtx) setCapturedCtx(captureContext());
    };
    reader.readAsDataURL(file);
    // Reset so the same file can be re-selected
    e.target.value = "";
  }, [capturedCtx, captureContext]);

  // ── Filter context by selected signals before sending ──────────────

  const getFilteredContext = useCallback((): BugContext | null => {
    if (!capturedCtx) return null;
    return {
      ...capturedCtx,
      consoleErrors: capturedCtx.consoleErrors.filter((_, i) => selectedSignals.has(`console-${i}`)),
      networkErrors: capturedCtx.networkErrors.filter((_, i) => selectedSignals.has(`net-${i}`)),
    };
  }, [capturedCtx, selectedSignals]);

  // ── Augment with Haiku ─────────────────────────────────────────────

  const handleAugment = useCallback(async () => {
    if (!description.trim()) return;
    setAugmenting(true);
    setError(null);

    const ctx = getFilteredContext() ?? captureContext();
    if (!capturedCtx) setCapturedCtx(captureContext());

    try {
      const res = await fetch(`${CORE_URL}/api/evolution/bug-hunt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          screenshots: screenshot ? [screenshot] : undefined,
          context: ctx,
        }),
      });

      const data = (await res.json()) as { augmented?: AugmentedBug; screenshotPaths?: string[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Analysis failed");
        return;
      }

      if (data.augmented) {
        setAugmented(data.augmented);
        setScreenshotPaths(data.screenshotPaths ?? []);
        setEditedPrompt(data.augmented.taskPrompt);
        setPhase("augmented");
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setAugmenting(false);
    }
  }, [description, screenshot, capturedCtx, captureContext, getFilteredContext]);

  // ── Submit ─────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (autoExecute: boolean) => {
    if (!augmented) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${CORE_URL}/api/evolution/bug-hunt/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: augmented.title,
          description: augmented.description,
          category: augmented.category,
          priority: augmented.priority,
          scope: augmented.scope,
          taskPrompt: editingPrompt ? editedPrompt : augmented.taskPrompt,
          screenshotPaths,
          autoExecute,
          auto: autoExecute ? autoMode : false,
        }),
      });

      const data = (await res.json()) as { execution?: ExecutionData; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Submission failed");
        return;
      }

      if (autoExecute && data.execution) {
        setExecution(data.execution);
        setPhase("executing");
      } else {
        handleClose();
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setSubmitting(false);
    }
  }, [augmented, editingPrompt, editedPrompt, screenshotPaths, autoMode]);

  // ── Evolution callbacks ────────────────────────────────────────────

  const handleComplete = useCallback((r: CompleteResult) => {
    setLastRunId(execution?.runId ?? null);
    setResult(r);
    setExecution(null);
    setPhase("result");
  }, [execution]);

  // ── Close + reset ──────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    close();
    setTimeout(() => {
      setPhase("report");
      setDescription("");
      setScreenshot(null);
      setCapturedCtx(null);
      setAugmented(null);
      setScreenshotPaths([]);
      setEditingPrompt(false);
      setEditedPrompt("");
      setError(null);
      setExecution(null);
      setResult(null);
      setLastRunId(null);
      setSelectedSignals(new Set());
      setSignalsExpanded(false);
      // Keep auto mode preference — it's persisted in localStorage
    }, 200);
  }, [close]);

  // ── Whether dialog is in expanded (terminal) mode ──────────────────

  const isExpanded = phase === "executing";

  const selectedCount = selectedSignals.size;
  const totalCount = allSignals.length;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent
        data-bug-hunt-overlay="true"
        showCloseButton={false}
        className={cn(
          "p-0 gap-0 overflow-hidden transition-all duration-200 ease-out",
          isExpanded
            ? "w-[calc(100vw-1.5rem)] h-[calc(100svh-1.5rem)] sm:max-w-[calc(100vw-1.5rem)]"
            : "sm:max-w-2xl",
        )}
        onInteractOutside={(e) => {
          if (phase === "executing") e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Intelligence</DialogTitle>
        <DialogDescription className="sr-only">Submit to the intelligence system</DialogDescription>

        {/* Hidden file input for manual screenshot upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />

        {/* ── Phase: Report ──────────────────────────────────────── */}
        {phase === "report" && (
          <div className="p-5 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={AiSearch02Icon} size={14} className="text-dim-foreground" />
              <span className="text-xs text-muted-foreground">Intelligence</span>
              <span className="text-xs text-muted-foreground ml-auto hidden sm:inline">
                {"\u21E7\u2318"}X captures screen
              </span>
            </div>

            {/* Screenshot + text input */}
            <div className="flex gap-4">
              {screenshot && (
                <div className="relative group shrink-0">
                  <Image
                    src={screenshot}
                    alt="Captured screenshot"
                    width={160}
                    height={100}
                    className="w-40 h-24 object-cover object-top rounded-lg border border-border/30"
                    unoptimized
                  />
                  <button
                    type="button"
                    onClick={() => setScreenshot(null)}
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-background border border-border/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={10} className="text-muted-foreground" />
                  </button>
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={mode === "feature" ? "Describe the feature you'd like..." : "What's happening?"}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none min-h-[96px] leading-relaxed"
                rows={4}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && description.trim()) {
                    void handleAugment();
                  }
                }}
              />
            </div>

            {/* Context signals */}
            {capturedCtx && totalCount > 0 && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setSignalsExpanded((v) => !v)}
                  className="flex items-center gap-1.5 group"
                >
                  <HugeiconsIcon icon={AlertCircleIcon} size={12} className="text-status-warning/60" />
                  <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                    {selectedCount}/{totalCount} signals selected
                  </span>
                  <svg
                    viewBox="0 0 10 6"
                    className={cn(
                      "size-2.5 text-dim-foreground transition-transform duration-150",
                      signalsExpanded && "rotate-180"
                    )}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M1 1l4 4 4-4" />
                  </svg>
                  <span className="text-xs text-dim-foreground mx-1">·</span>
                  <span className="text-xs text-muted-foreground">{capturedCtx.route}</span>
                </button>

                {signalsExpanded && (
                  <div className="flex items-center gap-1 pl-5 pb-1">
                    <button
                      type="button"
                      onClick={selectAllSignals}
                      disabled={selectedCount === totalCount}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-xs text-dim-foreground">·</span>
                    <button
                      type="button"
                      onClick={deselectAllSignals}
                      disabled={selectedCount === 0}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
                    >
                      Deselect all
                    </button>
                  </div>
                )}

                {signalsExpanded && (
                  <div className="space-y-0.5 pl-0.5">
                    {allSignals.map((signal) => {
                      const isSelected = selectedSignals.has(signal.id);
                      return (
                        <button
                          key={signal.id}
                          type="button"
                          onClick={() => toggleSignal(signal.id)}
                          className={cn(
                            "flex items-center gap-2 w-full text-left rounded-md px-2 py-1.5 transition-colors",
                            isSelected
                              ? "bg-muted/20"
                              : "opacity-40 hover:opacity-60"
                          )}
                        >
                          <div className={cn(
                            "size-3.5 rounded border flex items-center justify-center shrink-0 transition-colors",
                            isSelected
                              ? "border-foreground/30 bg-foreground/10"
                              : "border-border/60"
                          )}>
                            {isSelected && (
                              <svg viewBox="0 0 10 8" className="size-2 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1 4l3 3 5-6" />
                              </svg>
                            )}
                          </div>
                          <HugeiconsIcon
                            icon={signal.type === "network" ? Wifi01Icon : AlertCircleIcon}
                            size={11}
                            className={cn(
                              "shrink-0",
                              signal.type === "error" || signal.type === "network" ? "text-status-critical" : "text-status-warning"
                            )}
                          />
                          <span className="text-xs text-muted-foreground font-mono break-all leading-relaxed">
                            {signal.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* No errors state */}
            {capturedCtx && totalCount === 0 && (
              <div className="flex items-center gap-1.5">
                <HugeiconsIcon icon={CheckmarkCircle01Icon} size={12} className="text-status-healthy/60" />
                <span className="text-xs text-muted-foreground">No errors detected</span>
                <span className="text-xs text-dim-foreground mx-1">·</span>
                <span className="text-xs text-muted-foreground">{capturedCtx.route}</span>
              </div>
            )}

            {error && <p className="text-xs text-status-critical/80">{error}</p>}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1 border-t border-border/30">
              <Button
                size="sm"
                className="h-8 text-xs gap-1.5"
                disabled={!description.trim() || augmenting}
                onClick={handleAugment}
              >
                {augmenting ? (
                  <>
                    <Spinner className="size-3" />
                    <Shimmer as="span" duration={1.5}>Analyzing...</Shimmer>
                  </>
                ) : (
                  <>
                    <HugeiconsIcon icon={AiSearch02Icon} size={12} />
                    Analyze
                  </>
                )}
              </Button>

              {!screenshot && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-muted-foreground gap-1.5"
                    onClick={captureScreenshot}
                  >
                    <HugeiconsIcon icon={CenterFocusIcon} size={12} />
                    Screenshot
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs text-muted-foreground gap-1.5"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <HugeiconsIcon icon={ImageAdd01Icon} size={12} />
                    Add image
                  </Button>
                </>
              )}

              {screenshot && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground gap-1.5"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HugeiconsIcon icon={ImageAdd01Icon} size={12} />
                  Replace
                </Button>
              )}

              <span className="text-xs text-muted-foreground ml-auto hidden sm:inline">
                {"\u2318"}+Enter
              </span>
            </div>
          </div>
        )}

        {/* ── Phase: Augmented ───────────────────────────────────── */}
        {phase === "augmented" && augmented && (
          <div className="flex flex-col max-h-[80svh]">
            {/* Header */}
            <div className="px-5 py-4 border-b border-border/30 shrink-0">
              <div className="flex items-start gap-3">
                <div className={cn(
                  "size-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                  categoryVisual(augmented.category).bg,
                )}>
                  <HugeiconsIcon icon={categoryVisual(augmented.category).icon} size={16} className={categoryVisual(augmented.category).color} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{augmented.title}</p>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4 font-normal bg-muted/50">
                      {augmented.category}
                    </Badge>
                    <Badge variant="secondary" className={`text-xs px-1.5 py-0 h-4 font-normal bg-muted/50 ${priorityColor[augmented.priority] ?? ""}`}>
                      {augmented.priority}
                    </Badge>
                    <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4 font-normal bg-muted/50">
                      {augmented.scope}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>

            {/* Body (scrollable) */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">{augmented.description}</p>

              {/* Steps to reproduce */}
              {augmented.stepsToReproduce.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Steps to reproduce</p>
                  <ol className="list-decimal list-inside space-y-1">
                    {augmented.stepsToReproduce.map((step, i) => (
                      <li key={i} className="text-sm text-muted-foreground">{step}</li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Expected vs Actual */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-muted/15 p-3">
                  <p className="text-xs text-muted-foreground mb-1">Expected</p>
                  <p className="text-sm text-muted-foreground">{augmented.expectedBehavior}</p>
                </div>
                <div className="rounded-lg bg-muted/15 p-3">
                  <p className="text-xs text-muted-foreground mb-1">Actual</p>
                  <p className="text-sm text-muted-foreground">{augmented.actualBehavior}</p>
                </div>
              </div>

              {/* Captured signals — selectable checkboxes */}
              {allSignals.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground">
                      Included signals ({selectedCount}/{totalCount})
                    </p>
                    <button
                      type="button"
                      onClick={selectAllSignals}
                      disabled={selectedCount === totalCount}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-xs text-dim-foreground">·</span>
                    <button
                      type="button"
                      onClick={deselectAllSignals}
                      disabled={selectedCount === 0}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-default transition-colors"
                    >
                      Deselect all
                    </button>
                  </div>
                  <div className="space-y-0.5">
                    {allSignals.map((signal) => {
                      const isSelected = selectedSignals.has(signal.id);
                      return (
                        <button
                          key={signal.id}
                          type="button"
                          onClick={() => toggleSignal(signal.id)}
                          className={cn(
                            "flex items-center gap-2 w-full text-left rounded-md px-2 py-1.5 transition-colors",
                            isSelected
                              ? "bg-muted/15"
                              : "opacity-40 hover:opacity-60"
                          )}
                        >
                          <div className={cn(
                            "size-3.5 rounded border flex items-center justify-center shrink-0 transition-colors",
                            isSelected
                              ? "border-foreground/30 bg-foreground/10"
                              : "border-border/60"
                          )}>
                            {isSelected && (
                              <svg viewBox="0 0 10 8" className="size-2 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1 4l3 3 5-6" />
                              </svg>
                            )}
                          </div>
                          <HugeiconsIcon
                            icon={signal.type === "network" ? Wifi01Icon : AlertCircleIcon}
                            size={11}
                            className={cn(
                              "shrink-0",
                              signal.type === "error" || signal.type === "network" ? "text-status-critical/60" : "text-status-warning/60"
                            )}
                          />
                          <span className="text-xs text-muted-foreground font-mono break-all leading-relaxed">
                            {signal.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Instructions (editable) */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs text-muted-foreground">Instructions</p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPrompt((v) => !v);
                      if (!editingPrompt) setEditedPrompt(augmented.taskPrompt);
                    }}
                    className="text-xs text-dim-foreground hover:text-muted-foreground transition-colors flex items-center gap-1"
                  >
                    <HugeiconsIcon icon={Edit02Icon} size={10} />
                    {editingPrompt ? "Done" : "Edit"}
                  </button>
                </div>
                {editingPrompt ? (
                  <textarea
                    value={editedPrompt}
                    onChange={(e) => setEditedPrompt(e.target.value)}
                    className="w-full bg-muted/15 text-xs text-muted-foreground font-mono px-3 py-2.5 rounded-lg resize-none outline-none border border-border/30 focus:border-border/50 transition-colors min-h-[100px] leading-relaxed"
                    rows={5}
                  />
                ) : (
                  <div className="rounded-lg bg-muted/15 p-3">
                    <p className="text-xs text-muted-foreground font-mono whitespace-pre-wrap leading-relaxed">
                      {editedPrompt || augmented.taskPrompt}
                    </p>
                  </div>
                )}
              </div>

              {error && <p className="text-xs text-status-critical/80">{error}</p>}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border/30 space-y-2.5 shrink-0">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  disabled={submitting}
                  onClick={() => handleSubmit(true)}
                >
                  {submitting ? (
                    <>
                      <Spinner className="size-3" />
                      Launching...
                    </>
                  ) : (
                    <>
                      <HugeiconsIcon icon={PlayIcon} size={12} />
                      Execute now
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  disabled={submitting}
                  onClick={() => handleSubmit(false)}
                >
                  Queue to Intelligence
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground ml-auto"
                  disabled={submitting}
                  onClick={() => {
                    setPhase("report");
                    setAugmented(null);
                  }}
                >
                  Back
                </Button>
              </div>
              {/* Auto mode toggle */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAutoMode((v) => {
                    const next = !v;
                    localStorage.setItem("talome-auto-mode", String(next));
                    return next;
                  })}
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
                  — skip approvals, auto-revert on failure
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── Phase: Executing ───────────────────────────────────── */}
        {phase === "executing" && execution && (
          <div className="flex flex-col h-full">
            <EvolutionTerminal
              sessionName={execution.sessionName}
              command={execution.command}
              taskPrompt={execution.taskPrompt}
              runId={execution.runId}
              scope={execution.scope}
              completeLabel="Done"
              onComplete={handleComplete}
              onCancel={handleClose}
            />
          </div>
        )}

        {/* ── Phase: Result ──────────────────────────────────────── */}
        {phase === "result" && result && (
          <div className="p-5">
            <ExecutionResult
              result={result}
              runId={lastRunId ?? undefined}
              onBack={handleClose}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
