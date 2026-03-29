"use client";

import Image from "next/image";
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { toast } from "sonner";
import useSWR from "swr";
import { motion, AnimatePresence } from "framer-motion";
import { HugeiconsIcon, Cancel01Icon, AiChat02Icon, CloudUploadIcon, Edit02Icon, Share04Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CORE_URL, getHostUrl } from "@/lib/constants";
import { talomePost, talomeDelete, talomePatch } from "@/hooks/use-talome-api";
import { Streamdown } from "streamdown";
import { PillIndicator } from "@/components/kibo-ui/pill";
import { ClaudeTerminal } from "@/components/terminal/claude-terminal";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import type { CatalogApp } from "@talome/types";
import type { ServiceStack } from "@talome/types";

function ExternalLinkDialog({
  url,
  open,
  onOpenChange,
}: {
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  let hostname = url;
  try { hostname = new URL(url).hostname; } catch { /* keep url */ }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[19rem] gap-0 p-0 overflow-hidden" showCloseButton={false}>
        {/* Body */}
        <div className="flex flex-col items-center text-center px-7 pt-9 pb-7 gap-4">
          <span className="text-2xl leading-none select-none">🔗</span>

          <div className="grid gap-1">
            <DialogTitle className="text-base font-medium tracking-tight">
              Open External Link?
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground font-mono truncate max-w-full">
              {hostname}
            </DialogDescription>
          </div>
        </div>

        {/* Actions — hairline-divided, text-only */}
        <div className="grid grid-cols-2 border-t border-border divide-x divide-border">
          <button
            onClick={handleCopy}
            className="py-3.5 text-sm font-medium text-muted-foreground hover:bg-muted/40 transition-colors"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onOpenChange(false)}
            className="py-3.5 text-sm font-medium hover:bg-muted/40 transition-colors text-center"
          >
            Open
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImagePreviewDialog({
  images,
  index,
  open,
  onOpenChange,
  onIndexChange,
}: {
  images: string[];
  index: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (next: number) => void;
}) {
  const currentIndex = Math.max(0, Math.min(index, images.length - 1));
  const current = images[currentIndex];

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onOpenChange(false); return; }
      if (event.key === "ArrowLeft") onIndexChange((currentIndex - 1 + images.length) % images.length);
      if (event.key === "ArrowRight") onIndexChange((currentIndex + 1) % images.length);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, currentIndex, images.length, onIndexChange, onOpenChange]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="preview-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          onClick={() => onOpenChange(false)}
          style={{ background: "rgba(0,0,0,0.92)" }}
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 z-10 flex items-center justify-center size-9 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors backdrop-blur-sm"
            onClick={(e) => { e.stopPropagation(); onOpenChange(false); }}
            aria-label="Close preview"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} />
          </button>

          {/* Counter */}
          {images.length > 1 && (
            <div className="absolute top-5 left-1/2 -translate-x-1/2 text-white/50 text-xs tabular-nums pointer-events-none select-none">
              {currentIndex + 1} / {images.length}
            </div>
          )}

          {/* Image */}
          <motion.img
            key={current}
            src={current}
            alt={`Preview ${currentIndex + 1}`}
            className="max-w-[92vw] max-h-[88vh] w-auto h-auto object-contain rounded-xl shadow-2xl"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          />

          {/* Arrow buttons */}
          {images.length > 1 && (
            <>
              <button
                className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center justify-center size-10 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors backdrop-blur-sm"
                onClick={(e) => { e.stopPropagation(); onIndexChange((currentIndex - 1 + images.length) % images.length); }}
                aria-label="Previous image"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <button
                className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center justify-center size-10 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors backdrop-blur-sm"
                onClick={(e) => { e.stopPropagation(); onIndexChange((currentIndex + 1) % images.length); }}
                aria-label="Next image"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const SOURCE_LABELS: Record<string, string> = {
  talon: "Talome",
  casaos: "CasaOS",
  umbrel: "Umbrel",
  "user-created": "My Apps",
};

type InstallStage = "queued" | "pulling" | "creating" | "starting" | "running" | "error";

const STAGE_LABELS: Record<InstallStage, string> = {
  queued:   "Preparing...",
  pulling:  "Pulling image...",
  creating: "Starting containers...",
  starting: "Starting...",
  running:  "Ready",
  error:    "Installation failed",
};

const STAGE_PROGRESS: Record<InstallStage, number> = {
  queued:   5,
  pulling:  35,
  creating: 75,
  starting: 90,
  running:  100,
  error:    100,
};

function InstallProgress({ stage, message }: { stage: InstallStage; message: string }) {
  const progress = STAGE_PROGRESS[stage];
  const isError = stage === "error";
  const isPreparing = stage === "queued";

  return (
    <div className="w-full max-w-xs grid gap-3">
      <div className="grid gap-1.5">
        {isPreparing ? (
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
            <div className="absolute inset-0 h-full w-full animate-[install-shimmer_1.8s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
          </div>
        ) : (
          <Progress value={progress} className={`h-1.5 ${isError ? "[&>div]:bg-destructive" : ""}`} />
        )}
        <p className={`text-xs text-center transition-opacity duration-150 ${isError ? "text-destructive" : "text-muted-foreground"}`}>
          {message || STAGE_LABELS[stage]}
        </p>
      </div>
    </div>
  );
}

function needsAiSetup(app: CatalogApp): boolean {
  return !!app.env?.some((e) => e.required && !e.default);
}

function buildSetupPrompt(app: CatalogApp): string {
  const requiredVars = app.env?.filter((e) => e.required && !e.default) ?? [];
  const varList = requiredVars.map((v) => `- ${v.label} (${v.key})${v.secret ? " [secret]" : ""}`).join("\n");
  return `Install "${app.name}" for me. It needs configuration before it can start:\n\n${varList}\n\n${app.installNotes ? `Install notes: ${app.installNotes}\n\n` : ""}Walk me through the setup and install it when ready.`;
}

export default function AppDetailPage() {
  const { storeId, appId } = useParams<{ storeId: string; appId: string }>();
  const [, setPageTitle] = useAtom(pageTitleAtom);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [volumeValues, setVolumeValues] = useState<Record<string, string>>({});
  const [installStage, setInstallStage] = useState<InstallStage | null>(null);
  const [installMessage, setInstallMessage] = useState("");
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [submittingCommunity, setSubmittingCommunity] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [coverFailed, setCoverFailed] = useState(false);
  const [claudeSession, setClaudeSession] = useState<{ sessionName: string; command: string; taskPrompt: string } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [editingPorts, setEditingPorts] = useState(false);
  const [draftPorts, setDraftPorts] = useState<Record<string, string>>({});
  const [savingPatch, setSavingPatch] = useState(false);
  const quickLook = useQuickLook();
  const sseRef = useRef<EventSource | null>(null);

  // Fetch service stacks to find containers for this app
  const { data: stacks } = useSWR<ServiceStack[]>(
    `${CORE_URL}/api/containers?grouped=true`,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  );
  const appStack = stacks?.find((s) => s.appId === appId || s.id === appId);

  const { data: app, isLoading, mutate } = useSWR<CatalogApp>(
    storeId && appId ? `${CORE_URL}/api/apps/${storeId}/${appId}` : null,
    fetcher,
    {
      refreshInterval: (data) => (data?.installed ? 5000 : 0),
      onSuccess: (data) => {
        if (!data.installed && Object.keys(envValues).length === 0) {
          const defaults: Record<string, string> = {};
          data.env?.forEach((e: { key: string; default?: string }) => {
            if (e.default) defaults[e.key] = e.default;
          });
          if (Object.keys(defaults).length > 0) setEnvValues(defaults);
        }
      },
      revalidateOnFocus: false,
    },
  );

  // Set title synchronously from URL, update when SWR data arrives.
  const resolvedName = app?.installed?.displayName || app?.name;
  useEffect(() => {
    setPageTitle(
      resolvedName ??
        appId.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    );
    return () => setPageTitle(null);
  }, [resolvedName, appId, setPageTitle]);

  // Clean up SSE on unmount
  const cleanupSSE = () => {
    sseRef.current?.close();
    sseRef.current = null;
  };

  const startProgressSSE = () => {
    cleanupSSE();
    const es = new EventSource(`/api/apps/${storeId}/${appId}/progress`);
    sseRef.current = es;

    es.addEventListener("progress", (e) => {
      const data = JSON.parse(e.data) as { stage: InstallStage; message: string };
      setInstallStage(data.stage);
      setInstallMessage(data.message);

      if (data.stage === "running" || data.stage === "error") {
        es.close();
        sseRef.current = null;
        if (data.stage === "running") {
          mutate().then(() => {
            setInstallStage(null);
            setInstallMessage("");
            toast.success(`${app?.name ?? "App"} installed successfully`);
          });
        } else {
          toast.error(`Installation failed`, {
            description: data.message || "An error occurred during installation.",
          });
        }
      }
    });

    es.onerror = () => {
      es.close();
      sseRef.current = null;
    };
  };

  const ACTION_SUCCESS: Record<string, string> = {
    start: "started",
    stop: "stopped",
    restart: "restarted",
    update: "updated",
    uninstall: "removed",
  };

  const runAction = async (action: string) => {
    if (!app) return;
    setActionLoading(action);
    try {
      if (action === "install") {
        startProgressSSE();
        setInstallStage("queued");
        setInstallMessage("Preparing...");
        await talomePost(`/api/apps/${storeId}/${appId}/install`, { env: envValues, volumeMounts: volumeValues });
      } else if (action === "uninstall") {
        await talomeDelete(`/api/apps/${storeId}/${appId}`);
        await mutate();
        toast.success(`${app.name} removed`);
      } else {
        await talomePost(`/api/apps/${storeId}/${appId}/${action}`);
        await mutate();
        const verb = ACTION_SUCCESS[action] ?? action;
        toast.success(`${app.name} ${verb}`);
      }
    } catch (err) {
      if (action === "install") {
        setInstallStage("error");
        setInstallMessage("Installation failed. Please try again.");
        cleanupSSE();
        toast.error("Installation failed", {
          description: err instanceof Error ? err.message : "Please try again.",
        });
      } else {
        const verb = ACTION_SUCCESS[action] ?? action;
        toast.error(`Failed to ${verb === action ? action : action} ${app.name}`, {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    } finally {
      setActionLoading(null);
    }
  };

  const submitToCommunity = async () => {
    if (submittingCommunity) return;
    setSubmittingCommunity(true);
    try {
      const result = await talomePost<{ submissionId?: string }>(`/api/user-apps/${appId}/publish`, { authorName: "Talome User" });
      toast.success("Submitted to community review", {
        description: result?.submissionId ? `Submission ID: ${result.submissionId}` : undefined,
      });
    } catch (err) {
      toast.error("Failed to submit for community review", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSubmittingCommunity(false);
    }
  };

  const launchClaudeSession = useCallback(async () => {
    if (!app || !appId) return;
    try {
      const res = await fetch(`${CORE_URL}/api/apps/create/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskPrompt: `You are continuing work on "${app.name}". This is an interactive session — the user is watching the terminal. Ask what they'd like to change or improve. The workspace is at the current directory. Read .talome-creator/blueprint.json for context on the app.`,
          appId,
        }),
      });
      const data = await res.json();
      setClaudeSession(data);
    } catch {
      toast.error("Failed to launch Claude Code session");
    }
  }, [app, appId]);

  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("/") || href.startsWith("#")) return;
      e.preventDefault();
      e.stopPropagation();
      setExternalUrl(href);
    };
    el.addEventListener("click", handler, true); // capture phase
    return () => el.removeEventListener("click", handler, true);
  }, []);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-xl grid gap-8 pt-2 pb-12">
        <Skeleton className="h-4 w-12" />
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="size-20 rounded-[1.25rem]" />
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-[140px] rounded-xl" />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="mx-auto w-full max-w-xl flex flex-col items-center justify-center py-32 gap-3">
        <p className="text-sm text-muted-foreground">App not found</p>
      </div>
    );
  }

  const isInstalled = !!app.installed;
  const status = app.installed?.status;
  const isRunning = status === "running";
  const hasRealIcon = app.iconUrl && !app.iconUrl.startsWith("file://");
  const isUserCreated = storeId === "user-apps";
  const requiresSetup = !isInstalled && needsAiSetup(app);
  const validScreenshots = (app.screenshots || []).filter(
    (s) => !s.startsWith("file://"),
  );
  const coverImage = app.coverUrl && !app.coverUrl.startsWith("file://") && !coverFailed ? app.coverUrl : undefined;
  const previewImages = coverImage
    ? [coverImage, ...validScreenshots.filter((url) => url !== coverImage)]
    : validScreenshots;

  return (
    <div ref={pageRef} className={`mx-auto w-full max-w-xl grid gap-10 pb-12${coverImage ? " pt-0" : " pt-2"}`}>
      {/* ── Hero ─────────────────────────────────────────── */}
      <div className={coverImage ? "app-detail-hero app-detail-hero--has-cover" : "app-detail-hero"}>
        {coverImage ? (
          <div className="relative w-full">
            <button
              type="button"
              className="app-detail-cover-frame app-detail-preview-trigger"
              onClick={() => { setPreviewIndex(0); setPreviewOpen(true); }}
            >
              <Image
                src={coverImage}
                alt={`${app.name} cover`}
                className="app-detail-cover-img"
                fill
                sizes="(max-width: 768px) 100vw, 720px"
                priority
                onError={() => setCoverFailed(true)}
              />
              {/* Gradient vignette so icon reads cleanly */}
              <div className="app-detail-cover-gradient" aria-hidden />
            </button>
          </div>
        ) : isUserCreated ? (
          <label className="group/cover relative flex items-center justify-center h-32 cursor-pointer overflow-hidden">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();
                formData.append("cover", file);
                try {
                  await fetch(`${CORE_URL}/api/user-apps/${appId}/cover`, {
                    method: "POST",
                    body: formData,
                  });
                  mutate();
                  toast.success("Cover updated");
                } catch {
                  toast.error("Failed to upload cover");
                }
              }}
            />
            <span className="flex flex-col items-center gap-1.5 text-xs tracking-wide text-muted-foreground sm:text-muted-foreground/0 sm:group-hover/cover:text-muted-foreground transition-colors duration-150">
              <HugeiconsIcon icon={CloudUploadIcon} size={18} />
              Add cover image
            </span>
            <div className="absolute inset-x-0 bottom-0 h-px bg-border/30 sm:bg-border/0 sm:group-hover/cover:bg-border/40 transition-colors duration-150" />
          </label>
        ) : null}

        <div className="flex flex-col items-center gap-2">
          <div className={`app-detail-hero-icon relative size-20 flex items-center justify-center rounded-[1.25rem] bg-muted text-2xl overflow-hidden${coverImage ? " app-detail-hero-icon--elevated" : ""}`}>
            {hasRealIcon ? (
              <Image
                src={app.iconUrl!}
                alt=""
                className="object-cover" fill
                sizes="80px"
                onError={(e) => {
                  const el = e.target as HTMLImageElement;
                  el.style.display = "none";
                  el.nextElementSibling?.classList.remove("hidden");
                }}
              />
            ) : null}
            <span className={hasRealIcon ? "hidden" : ""}>{app.icon}</span>
          </div>
          {isUserCreated && (
            <label className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <input
                type="file"
                accept="image/*,.svg"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const formData = new FormData();
                  formData.append("icon", file);
                  try {
                    await fetch(`${CORE_URL}/api/user-apps/${appId}/icon`, {
                      method: "POST",
                      body: formData,
                    });
                    await mutate();
                    toast.success("Icon updated");
                  } catch {
                    toast.error("Failed to upload icon");
                  }
                }}
              />
              <HugeiconsIcon icon={CloudUploadIcon} size={12} />
              Change icon
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center text-center gap-5">
        <div className="grid gap-1.5">
          {editingName ? (
            <form
              className="flex items-center gap-2 justify-center"
              onSubmit={async (e) => {
                e.preventDefault();
                const trimmed = draftName.trim();
                const currentName = app.installed?.displayName || app.name;
                if (!trimmed || trimmed === currentName) { setEditingName(false); return; }
                setSavingPatch(true);
                try {
                  await talomePatch(`/api/apps/${storeId}/${appId}`, { displayName: trimmed });
                  await mutate();
                  toast.success("App renamed");
                } catch { toast.error("Failed to rename"); }
                finally { setSavingPatch(false); setEditingName(false); }
              }}
            >
              <Input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="h-8 text-center text-lg font-medium w-48"
                onKeyDown={(e) => { if (e.key === "Escape") setEditingName(false); }}
              />
              <Button size="sm" type="submit" disabled={savingPatch}>
                {savingPatch ? "..." : "Save"}
              </Button>
            </form>
          ) : (
            <h1
              className="text-xl font-medium tracking-tight group/name cursor-pointer"
              onClick={() => {
                setDraftName(app.installed?.displayName || app.name);
                setEditingName(true);
              }}
            >
              {app.installed?.displayName || app.name}
              <HugeiconsIcon icon={Edit02Icon} size={14} className="inline-block ml-1.5 opacity-0 group-hover/name:opacity-40 transition-opacity" />
            </h1>
          )}
          <p className="text-sm text-muted-foreground max-w-sm">
            {app.tagline || app.description}
          </p>
        </div>

        {/* Tags — compact horizontally scrollable chips */}
        <div className="app-detail-tags">
          <span className="app-detail-tag">{app.category}</span>
          <span className="app-detail-tag app-detail-tag--muted">v{app.version}</span>
          <span className="app-detail-tag app-detail-tag--muted">
            {SOURCE_LABELS[app.source] || app.source}
          </span>
          {isInstalled && (
            <span className={`app-detail-tag app-detail-tag--muted flex items-center gap-1.5`}>
              <PillIndicator
                variant={isRunning ? "success" : status === "updating" || status === "installing" ? "warning" : "error"}
                pulse={status === "updating" || status === "installing"}
              />
              {status}
            </span>
          )}
        </div>

        {/* Primary action */}
        <div className="w-full max-w-xs grid gap-2 pt-1 place-items-center">
          {installStage ? (
            <InstallProgress stage={installStage} message={installMessage} />
          ) : isInstalled ? (
            <>
              {isRunning && app.webPort ? (
                <Button size="lg" className="w-full" asChild>
                  <a
                    href={getHostUrl(app.webPort)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open {app.name}
                  </a>
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => runAction(isRunning ? "stop" : "start")}
                  disabled={!!actionLoading}
                >
                  {actionLoading === "start"
                    ? "Starting..."
                    : actionLoading === "stop"
                      ? "Stopping..."
                      : isRunning
                        ? "Stop"
                        : "Start"}
                </Button>
              )}
            </>
          ) : requiresSetup ? (
            <Button size="lg" className="w-full gap-2" asChild>
              <Link href={`/dashboard/assistant?prompt=${encodeURIComponent(buildSetupPrompt(app))}`}>
                <HugeiconsIcon icon={AiChat02Icon} size={16} />
                Install with Assistant
              </Link>
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={() => runAction("install")}
              disabled={!!actionLoading}
              className="w-full"
            >
              {app.detectedRunning ? "Reinstall with Talome" : "Install"}
            </Button>
          )}
          {requiresSetup && (
            <p className="text-xs text-muted-foreground text-center">
              This app needs configuration before it can run
            </p>
          )}
          {!isInstalled && !requiresSetup && app.detectedRunning && (
            <p className="text-xs text-muted-foreground text-center">
              Already running as a container
            </p>
          )}
        </div>
      </div>

      {/* ── Screenshots ─────────────────────────────────── */}
      {validScreenshots.length > 0 && (
        <div className="app-detail-gallery">
          {validScreenshots.map((url, i) => (
            <button
              key={i}
              type="button"
              className="app-detail-preview-trigger"
              onClick={() => {
                const idx = previewImages.findIndex((item) => item === url);
                setPreviewIndex(idx >= 0 ? idx : 0);
                setPreviewOpen(true);
              }}
            >
              <Image
                src={url}
                alt={`Screenshot ${i + 1}`}
                width={720}
                height={384}
                className="app-detail-gallery-image"
              />
            </button>
          ))}
        </div>
      )}

      {/* ── Install Notes ───────────────────────────────── */}
      {app.installNotes && (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Before You Install
          </h2>
          <Streamdown
            className="text-sm text-muted-foreground leading-relaxed [&_strong]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mt-0.5"
          >
            {app.installNotes}
          </Streamdown>
        </section>
      )}

      {/* ── Description ─────────────────────────────────── */}
      {app.description && app.description !== app.tagline && (
        <section>
          <Streamdown
            className="text-sm text-muted-foreground leading-relaxed [&_strong]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mt-0.5"
          >
            {app.description}
          </Streamdown>
        </section>
      )}

      {/* ── Release Notes ───────────────────────────────── */}
      {app.releaseNotes && (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            What&apos;s New
          </h2>
          <Streamdown
            className="text-sm text-muted-foreground leading-relaxed [&_strong]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mt-0.5"
          >
            {app.releaseNotes}
          </Streamdown>
        </section>
      )}

      {/* ── Install-time config (only for apps without required setup) ── */}
      {!isInstalled && !requiresSetup && app.env?.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Configuration
          </h2>
          <div className="rounded-xl border border-border p-5 grid gap-4">
            {app.env.map((envVar) => (
              <div key={envVar.key} className="grid gap-1.5">
                <Label htmlFor={envVar.key} className="text-sm">
                  {envVar.label}
                  {envVar.required && (
                    <span className="text-destructive ml-1">*</span>
                  )}
                </Label>
                <Input
                  id={envVar.key}
                  type={envVar.secret ? "password" : "text"}
                  placeholder={envVar.default || envVar.key}
                  value={envValues[envVar.key] ?? ""}
                  onChange={(e) =>
                    setEnvValues((prev) => ({
                      ...prev,
                      [envVar.key]: e.target.value,
                    }))
                  }
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Media volume paths (install-time) ───────────── */}
      {!isInstalled && (() => {
        const mediaVols = app.volumes?.filter((v) => v.mediaVolume) ?? [];
        if (mediaVols.length === 0) return null;
        return (
          <section className="grid gap-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Media Libraries
            </h2>
            <div className="rounded-xl border border-border p-5 grid gap-4">
              {mediaVols.map((vol, i) => (
                <div key={vol.containerPath} className="grid gap-1.5">
                  <Label htmlFor={`vol-${i}-${vol.name}`} className="text-sm">
                    {vol.description || vol.name}
                  </Label>
                  <Input
                    id={`vol-${i}-${vol.name}`}
                    placeholder={`/path/to/your/${vol.name}`}
                    value={volumeValues[vol.name] ?? ""}
                    onChange={(e) =>
                      setVolumeValues((prev) => ({
                        ...prev,
                        [vol.name]: e.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty to configure later
                  </p>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {/* ── Information ─────────────────────────────────── */}
      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Information
        </h2>
        <div className="divide-y divide-border">
          {app.author && (
            <div className="flex justify-between items-center py-3 text-sm">
              <span className="text-muted-foreground">Developer</span>
              <span className="font-medium">{app.author}</span>
            </div>
          )}
          {app.website && (
            <div className="flex justify-between items-center py-3 text-sm">
              <span className="text-muted-foreground">Website</span>
              <a
                href={app.website}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-4 decoration-muted-foreground/30 hover:decoration-foreground transition-colors"
              >
                {(() => {
                  try {
                    return new URL(app.website).hostname;
                  } catch {
                    return app.website;
                  }
                })()}
              </a>
            </div>
          )}
          {app.ports?.length > 0 && (
            <div className="flex justify-between items-center py-3 text-sm">
              <span className="text-muted-foreground">Ports</span>
              {editingPorts ? (
                <form
                  className="flex items-center gap-2 flex-wrap justify-end"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const portMap: Record<string, number> = {};
                    let hasChange = false;
                    for (const p of app.ports) {
                      const val = parseInt(draftPorts[String(p.container)] || String(p.host), 10);
                      if (!isNaN(val) && val !== p.host) { portMap[String(p.container)] = val; hasChange = true; }
                    }
                    if (!hasChange) { setEditingPorts(false); return; }
                    setSavingPatch(true);
                    try {
                      const res = await talomePatch<{ portMessage?: string }>(`/api/apps/${storeId}/${appId}`, { ports: portMap });
                      await mutate();
                      toast.success(res.portMessage || "Ports updated");
                    } catch { toast.error("Failed to update ports"); }
                    finally { setSavingPatch(false); setEditingPorts(false); }
                  }}
                >
                  {app.ports.map((p) => (
                    <div key={p.container} className="flex items-center gap-1">
                      <Input
                        value={draftPorts[String(p.container)] ?? String(p.host)}
                        onChange={(e) => setDraftPorts((prev) => ({ ...prev, [String(p.container)]: e.target.value }))}
                        className="h-7 w-16 text-xs font-mono text-center"
                      />
                      <span className="text-muted-foreground text-xs">:{p.container}</span>
                    </div>
                  ))}
                  <Button size="sm" type="submit" disabled={savingPatch} className="h-7 text-xs">
                    {savingPatch ? "..." : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setEditingPorts(false)} className="h-7 text-xs">
                    Cancel
                  </Button>
                </form>
              ) : (
                <div
                  className="flex gap-1.5 flex-wrap justify-end group/ports cursor-pointer"
                  onClick={() => {
                    const draft: Record<string, string> = {};
                    for (const p of app.ports) draft[String(p.container)] = String(p.host);
                    setDraftPorts(draft);
                    setEditingPorts(true);
                  }}
                >
                  {app.ports.map((p, i) => (
                    <span key={i} className="port-chip">
                      {p.host}:{p.container}
                    </span>
                  ))}
                  <HugeiconsIcon icon={Edit02Icon} size={12} className="self-center opacity-0 group-hover/ports:opacity-40 transition-opacity" />
                </div>
              )}
            </div>
          )}
          {app.volumes?.length > 0 && (
            <div className="flex justify-between items-center py-3 text-sm">
              <span className="text-muted-foreground">Storage</span>
              <span className="font-medium tabular-nums">
                {app.volumes.length} volume
                {app.volumes.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}
          {app.architectures && app.architectures.length > 0 && (
            <div className="flex justify-between items-center py-3 text-sm">
              <span className="text-muted-foreground">Architecture</span>
              <span className="font-medium">
                {app.architectures.join(", ")}
              </span>
            </div>
          )}
          {app.dependencies && app.dependencies.length > 0 && (
            <div className="flex justify-between items-center py-3 text-sm">
              <span className="text-muted-foreground">Requires</span>
              <span className="font-medium">
                {app.dependencies.join(", ")}
              </span>
            </div>
          )}
        </div>
      </section>

      {isUserCreated && (
        <>
          <section className="grid gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Claude Code
            </h2>
            {claudeSession ? (
              <div className="h-[28rem] flex flex-col rounded-xl border overflow-hidden">
                <ClaudeTerminal
                  sessionName={claudeSession.sessionName}
                  command={claudeSession.command}
                  taskPrompt={claudeSession.taskPrompt}
                  completeLabel="Done"
                  onComplete={async () => { setClaudeSession(null); return { ok: true }; }}
                  onCancel={() => setClaudeSession(null)}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-border p-4 grid gap-3">
                <p className="text-sm text-muted-foreground">
                  Continue customizing this app — Claude remembers the workspace from when it was created.
                </p>
                <Button
                  variant="outline"
                  onClick={launchClaudeSession}
                  className="w-full sm:w-fit"
                >
                  Open Claude Code
                </Button>
              </div>
            )}
          </section>
          <section className="grid gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Community
            </h2>
            <div className="rounded-xl border border-border p-4 grid gap-3">
              <p className="text-sm text-muted-foreground">
                Share this app with other Talome users by sending it to the community review queue.
              </p>
              <Button
                variant="outline"
                onClick={submitToCommunity}
                disabled={submittingCommunity}
                className="w-full sm:w-fit"
              >
                {submittingCommunity ? "Submitting..." : "Submit to Community"}
              </Button>
            </div>
          </section>
        </>
      )}

      {/* ── Containers ──────────────────────────────────── */}
      {appStack && appStack.containers.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Containers
          </h2>
          <div className="rounded-xl border border-border divide-y divide-border">
            {appStack.containers.map((container) => {
              const tcpPorts = container.ports
                .filter((p) => p.protocol === "tcp" && p.host > 0)
                .map((p) => p.host)
                .filter((p, i, arr) => arr.indexOf(p) === i);
              const isContainerRunning = container.status === "running";

              return (
                <div key={container.id} className="px-4 py-3 grid gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <PillIndicator
                        variant={isContainerRunning ? "success" : container.status === "restarting" ? "warning" : "error"}
                        pulse={container.status === "restarting"}
                      />
                      <span className="text-sm font-medium truncate">{container.name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{container.status}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <code className="bg-muted px-1.5 py-0.5 rounded truncate max-w-[240px]">{container.image}</code>
                  </div>
                  {tcpPorts.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {tcpPorts.map((port) =>
                        isContainerRunning ? (
                          <button
                            key={port}
                            type="button"
                            onClick={() => quickLook.open(container)}
                            className="port-chip"
                          >
                            <HugeiconsIcon icon={Share04Icon} size={10} />
                            {port}
                          </button>
                        ) : (
                          <span key={port} className="port-chip port-chip-inactive">{port}</span>
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Lifecycle controls (installed only) ────────── */}
      {isInstalled && (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Controls
          </h2>
          <div className="rounded-xl border border-border divide-y divide-border">
            <button
              onClick={() => runAction("restart")}
              disabled={!!actionLoading}
              className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <span>Restart</span>
              {actionLoading === "restart" && (
                <span className="text-muted-foreground text-xs">Restarting...</span>
              )}
            </button>
            <button
              onClick={() => runAction("update")}
              disabled={!!actionLoading}
              className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <span>Check for Update</span>
              {actionLoading === "update" && (
                <span className="text-muted-foreground text-xs">Updating...</span>
              )}
            </button>
            {isRunning ? (
              <button
                onClick={() => runAction("stop")}
                disabled={!!actionLoading}
                className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <span>Stop</span>
                {actionLoading === "stop" && (
                  <span className="text-muted-foreground text-xs">Stopping...</span>
                )}
              </button>
            ) : (
              <button
                onClick={() => runAction("start")}
                disabled={!!actionLoading}
                className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <span>Start</span>
                {actionLoading === "start" && (
                  <span className="text-muted-foreground text-xs">Starting...</span>
                )}
              </button>
            )}
            <button
              onClick={() => runAction("uninstall")}
              disabled={!!actionLoading}
              className="w-full flex justify-between items-center px-4 py-3 text-sm text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
            >
              <span>Uninstall</span>
              {actionLoading === "uninstall" && (
                <span className="text-xs opacity-70">Removing...</span>
              )}
            </button>
          </div>
        </section>
      )}

      {/* ── Default credentials ─────────────────────────── */}
      {app.defaultUsername && (
        <p className="text-xs text-muted-foreground text-center">
          Default login: {app.defaultUsername}
          {app.defaultPassword ? ` / ${app.defaultPassword}` : ""}
        </p>
      )}

      {/* ── External link dialog ─────────────────────────── */}
      {externalUrl && (
        <ExternalLinkDialog
          url={externalUrl}
          open={!!externalUrl}
          onOpenChange={(open) => { if (!open) setExternalUrl(null); }}
        />
      )}
      <ImagePreviewDialog
        images={previewImages}
        index={previewIndex}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        onIndexChange={setPreviewIndex}
      />
    </div>
  );
}
