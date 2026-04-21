"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon, ComputerTerminal01Icon, ArrowDown01Icon, Bug01Icon, BulbChargingIcon, AiChemistry02Icon, RepeatIcon, Tick01Icon, SourceCodeCircleIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { InlineMarkdown } from "@/components/ui/inline-markdown";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

function getSuggestionOrigin(s: Suggestion): { icon: IconSvgElement; color: string } {
  if (s.source === "bug_hunt") {
    if (s.category === "feature") return { icon: BulbChargingIcon, color: "text-status-warning/50" };
    return { icon: Bug01Icon, color: "text-status-critical/50" };
  }
  return { icon: AiChemistry02Icon, color: "text-dim-foreground" };
}

export interface Suggestion {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  risk: string;
  sourceSignals: string[];
  taskPrompt: string;
  scope: string;
  status: string;
  source?: string;
  screenshots?: string[];
  dismissReason?: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SuggestionCardProps {
  suggestion: Suggestion;
  onExecute: (suggestion: Suggestion, auto?: boolean) => void;
  onDismiss: (id: string, reason?: string) => void;
  /** Opens the existing session inline (embedded terminal). */
  onView?: (suggestion: Suggestion) => void;
  onViewTerminal?: (sessionName: string) => void;
  onReinject?: (runId: string, auto?: boolean) => void;
  onMarkDone?: (id: string) => void;
}

const riskLabel: Record<string, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

function screenshotUrl(path: string): string {
  const filename = path.split("/").pop() ?? "";
  return `${CORE_URL}/api/evolution/screenshots/${filename}`;
}

export function SuggestionRow({ suggestion, onExecute, onDismiss, onView, onViewTerminal, onReinject, onMarkDone }: SuggestionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [autoMode, setAutoMode] = useState(false);
  const screenshots = suggestion.screenshots ?? [];

  // Sync auto mode from localStorage after hydration
  useEffect(() => {
    setAutoMode(localStorage.getItem("talome-auto-mode") === "true");
  }, []);

  return (
    <>
      <div className="group">
        {/* Row — entire area is tappable */}
        <button
          type="button"
          className="flex w-full items-start gap-3 px-3 py-3 sm:px-4 sm:py-3.5 text-left transition-colors duration-150 hover:bg-muted/20"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={getSuggestionOrigin(suggestion).icon} size={13} className={`${getSuggestionOrigin(suggestion).color} shrink-0`} />
              <p className="font-medium text-sm text-foreground"><InlineMarkdown text={suggestion.title} /></p>
              {suggestion.risk === "high" && (
                <Badge
                  variant="secondary"
                  className="text-xs px-1.5 py-0 h-4 shrink-0 font-normal bg-muted/50 text-muted-foreground"
                >
                  High risk
                </Badge>
              )}
            </div>
            <p className={cn(
              "text-sm text-muted-foreground mt-0.5 leading-relaxed",
              !expanded && "line-clamp-2"
            )}>
              <InlineMarkdown text={suggestion.description} />
            </p>
            {suggestion.sourceSignals.length > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Based on: {suggestion.sourceSignals.slice(0, 3).join(", ")}
              </p>
            )}
          </div>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={13}
            className={`flex-shrink-0 mt-1 text-dim-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
        </button>

        {/* Expandable detail — animated with CSS grid */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
          style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            <div className="px-3 pb-3 sm:px-4 sm:pb-4">
              <div className="border-t border-border/30 pt-3 space-y-3">
                {/* Screenshots */}
                {screenshots.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {screenshots.map((path) => (
                      <button
                        key={path}
                        type="button"
                        className="flex-shrink-0 rounded-lg overflow-hidden border border-border/30 hover:border-border/60 transition-[border-color,transform] duration-150 hover:translate-y-[-1px]"
                        onClick={() => setLightboxSrc(screenshotUrl(path))}
                      >
                        <Image
                          src={screenshotUrl(path)}
                          alt="Screenshot"
                          width={96}
                          height={64}
                          className="w-24 h-16 object-cover"
                          unoptimized
                        />
                      </button>
                    ))}
                  </div>
                )}

                {/* Task prompt — fully visible when card is expanded */}
                {suggestion.taskPrompt && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <HugeiconsIcon icon={SourceCodeCircleIcon} size={12} className="text-dim-foreground" />
                      <span className="text-xs text-muted-foreground">Prompt</span>
                    </div>
                    <pre className="rounded-lg bg-muted/20 p-3 text-xs text-muted-foreground font-mono whitespace-pre-wrap break-words leading-relaxed">
                      {suggestion.taskPrompt}
                    </pre>
                  </div>
                )}

                {/* Metadata + actions */}
                {dismissing ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={dismissReason}
                      onChange={(e) => setDismissReason(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          onDismiss(suggestion.id, dismissReason || undefined);
                          setDismissing(false);
                          setDismissReason("");
                        } else if (e.key === "Escape") {
                          setDismissing(false);
                          setDismissReason("");
                        }
                      }}
                      placeholder="Reason (optional) — Enter to confirm"
                      className="flex-1 bg-muted/30 rounded-lg px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground border-none outline-none focus:ring-1 focus:ring-border/50 transition-shadow duration-200"
                      autoFocus
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        onDismiss(suggestion.id, dismissReason || undefined);
                        setDismissing(false);
                        setDismissReason("");
                      }}
                    >
                      Dismiss
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => { setDismissing(false); setDismissReason(""); }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 pt-1">
                    {suggestion.status === "in_progress" && suggestion.runId ? (
                      <>
                        {onView ? (
                          <Button
                            size="sm"
                            className="h-7 text-xs gap-1.5"
                            onClick={() => onView(suggestion)}
                          >
                            <HugeiconsIcon icon={ComputerTerminal01Icon} size={12} />
                            View
                          </Button>
                        ) : onViewTerminal ? (
                          <Button
                            size="sm"
                            className="h-7 text-xs gap-1.5"
                            onClick={() => onViewTerminal(`sess_evolution-${suggestion.runId}`)}
                          >
                            <HugeiconsIcon icon={ComputerTerminal01Icon} size={12} />
                            View in Terminal
                          </Button>
                        ) : null}
                        {onReinject && (
                          <div className={cn(
                            "flex items-center h-7 rounded-md transition-colors",
                            autoMode ? "bg-status-warning/10 ring-1 ring-status-warning/20" : "bg-muted/30 ring-1 ring-border/50"
                          )}>
                            <button
                              type="button"
                              className="flex items-center gap-1.5 h-7 px-2 rounded-l-md transition-colors hover:bg-muted/20"
                              onClick={() => setAutoMode((v) => {
                                const next = !v;
                                localStorage.setItem("talome-auto-mode", String(next));
                                return next;
                              })}
                            >
                              <span className={cn(
                                "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
                                autoMode ? "bg-status-warning" : "bg-input"
                              )}>
                                <span className={cn(
                                  "inline-block size-2.5 rounded-full bg-white transition-transform",
                                  autoMode ? "translate-x-3" : "translate-x-0.5"
                                )} />
                              </span>
                              <span className={cn(
                                "text-xs font-medium transition-colors",
                                autoMode ? "text-status-warning" : "text-muted-foreground"
                              )}>
                                Auto
                              </span>
                            </button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={cn(
                                "h-7 text-xs gap-1.5 rounded-l-none",
                                autoMode
                                  ? "text-status-warning/80 hover:text-status-warning hover:bg-status-warning/10"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                              onClick={() => onReinject(suggestion.runId!, autoMode)}
                            >
                              <HugeiconsIcon icon={RepeatIcon} size={12} />
                              Retry
                            </Button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className={cn(
                        "flex items-center h-7 rounded-md transition-colors",
                        autoMode ? "bg-status-warning/10 ring-1 ring-status-warning/20" : "bg-muted/30 ring-1 ring-border/50"
                      )}>
                        <button
                          type="button"
                          className="flex items-center gap-1.5 h-7 px-2 rounded-l-md transition-colors hover:bg-muted/20"
                          onClick={() => setAutoMode((v) => {
                            const next = !v;
                            localStorage.setItem("talome-auto-mode", String(next));
                            return next;
                          })}
                        >
                          <span className={cn(
                            "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
                            autoMode ? "bg-status-warning" : "bg-input"
                          )}>
                            <span className={cn(
                              "inline-block size-2.5 rounded-full bg-white transition-transform",
                              autoMode ? "translate-x-3" : "translate-x-0.5"
                            )} />
                          </span>
                          <span className={cn(
                            "text-xs font-medium transition-colors",
                            autoMode ? "text-status-warning" : "text-muted-foreground"
                          )}>
                            Auto
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 text-xs gap-1.5 rounded-l-none",
                            autoMode
                              ? "text-status-warning/80 hover:text-status-warning hover:bg-status-warning/10"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                          onClick={() => onExecute(suggestion, autoMode)}
                        >
                          <HugeiconsIcon icon={ComputerTerminal01Icon} size={12} />
                          Execute
                        </Button>
                      </div>
                    )}
                    {onMarkDone && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-dim-foreground hover:text-status-healthy gap-1.5"
                        onClick={() => onMarkDone(suggestion.id)}
                      >
                        <HugeiconsIcon icon={Tick01Icon} size={12} />
                        Done
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-dim-foreground hover:text-destructive"
                      onClick={() => setDismissing(true)}
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      <Dialog open={!!lightboxSrc} onOpenChange={() => setLightboxSrc(null)}>
        <DialogContent className="max-w-3xl p-0 overflow-hidden bg-background/95 border-border" showCloseButton={false}>
          <DialogTitle className="sr-only">Screenshot</DialogTitle>
          <DialogDescription className="sr-only">Full-size screenshot preview</DialogDescription>
          {lightboxSrc && (
            <Image
              src={lightboxSrc}
              alt="Screenshot"
              width={1920}
              height={1080}
              className="w-full h-auto max-h-[80vh] object-contain"
              unoptimized
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
