"use client";

import Image from "next/image";
import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { toast } from "sonner";
import { toastWarning } from "@/lib/toast";
import useSWR, { mutate as globalMutate } from "swr";
import { motion, AnimatePresence } from "motion/react";
import { HugeiconsIcon, Cancel01Icon, AiChat02Icon, CloudUploadIcon, Edit02Icon, Share04Icon, SystemUpdate01Icon, LinkSquare01Icon, ArrowLeft01Icon, ArrowRight01Icon, Package01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, type StatusDotState } from "@/components/ui/status-dot";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { copyText } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { StaleRow, useLoadedAt, useLoadingPhase } from "@/components/data-state/data-state";
import { CORE_URL } from "@/lib/constants";
import { appOpenUrl } from "@/lib/app-open-url";
import { fetchJson, fetchErrorStatus } from "@/lib/fetch-json";
import { getContainerWebPort } from "@/lib/container-web-port";
import { isTransitionalInstallStatus, useAdaptiveInterval, POLL_ACTIVE_MS, POLL_IDLE_MS } from "@/lib/polling";
import { talomePost, talomeDelete, talomePatch, TalomeApiError } from "@/hooks/use-talome-api";
import { useAppOperations } from "@/hooks/use-app-operations";
import { useUser } from "@/hooks/use-user";
import {
  OPERATION_KIND_LABELS,
  describeOperationConflict,
  describeUpdateResponse,
  runningFromConflictBody,
  settledFailureFrom,
  updateOutcomeFromOperation,
  parseOperationConflict,
  summarizeUpdateOperation,
  type LifecycleOutcome,
  type OperationEvent,
  type OperationRecord,
} from "@/lib/app-operations";
import {
  installBlockReason,
  parseInstallPlan,
  planHasChoices,
  type UmbrelInstallOptions,
  type UmbrelInstallPlan,
} from "@/lib/umbrel-install";
import { OperationActivity, OperationFailure, OperationProgress } from "@/components/app-detail/operation-panels";
import { VerificationPanel, verificationUrl } from "@/components/app-detail/verification-panel";
import { UmbrelInstallDialog } from "@/components/app-detail/umbrel-install-dialog";
import { Streamdown } from "streamdown";
import { ClaudeTerminal } from "@/components/terminal/claude-terminal";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import type { CatalogApp, Container } from "@talome/types";
import type { ServiceStack } from "@talome/types";
import {
  resolveApplicationIcon,
  resolveApplicationIconUrl,
} from "@/components/native-app/native-app-icons";

function ExternalLinkDialog({
  url,
  open,
  onOpenChange,
}: {
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopy = async () => {
    const ok = await copyText(url);
    setCopyState(ok ? "copied" : "failed");
    if (ok) setTimeout(() => setCopyState("idle"), 2000);
  };

  let hostname = url;
  try { hostname = new URL(url).hostname; } catch { /* keep url */ }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[19rem] gap-0 p-0 overflow-hidden" showCloseButton={false}>
        {/* Body */}
        <div className="flex flex-col items-center text-center px-7 pt-9 pb-7 gap-4">
          <HugeiconsIcon icon={LinkSquare01Icon} size={24} className="text-muted-foreground" aria-hidden="true" />

          <div className="grid gap-1">
            <DialogTitle className="text-base font-medium tracking-tight">
              Open external link?
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
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Couldn't copy" : "Copy"}
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
                <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
              </button>
              <button
                className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center justify-center size-10 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors backdrop-blur-sm"
                onClick={(e) => { e.stopPropagation(); onIndexChange((currentIndex + 1) % images.length); }}
                aria-label="Next image"
              >
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const fetcher = <T,>(url: string) => fetchJson<T>(url);

/** The detail response: the catalog app, plus the store it is installed from when that's another store. */
type AppDetail = CatalogApp & { installedFrom?: { storeId: string; storeName: string } };

const SOURCE_LABELS: Record<string, string> = {
  talome: "Talome",
  talon: "Talome",
  casaos: "CasaOS",
  umbrel: "Umbrel",
  "user-created": "My Apps",
};

/** Keep polling fast this long after an action finishes so the UI settles. */
const ACTION_GRACE_MS = 20_000;

/** Lifecycle actions that run as journaled operations (409 when another one is running). */
type LifecycleAction = "install" | "update" | "uninstall" | "start" | "stop" | "restart";

const STATUS_LABELS: Record<string, { label: string; state: StatusDotState }> = {
  running: { label: "Running", state: "healthy" },
  stopped: { label: "Stopped", state: "stopped" },
  exited: { label: "Stopped", state: "stopped" },
  installing: { label: "Installing", state: "working" },
  updating: { label: "Updating", state: "working" },
  restarting: { label: "Restarting", state: "working" },
  error: { label: "Error", state: "failed" },
};

function statusLabel(status: string | undefined): { label: string; state: StatusDotState } {
  if (!status) return { label: "Unknown", state: "unknown" };
  return STATUS_LABELS[status] ?? { label: status.charAt(0).toUpperCase() + status.slice(1), state: "unknown" };
}

/** Failures the person dismissed stay dismissed for this browser session. */
const DISMISSED_KEY = "talome.app-detail.dismissed-operations";

function readDismissed(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>) {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Private mode or blocked storage: dismissal lasts until reload.
  }
}

/** Where "Open" goes for the app's web port, from the container's detected web UI when there is one. */
function openUrlFor(port: number, container: Container | undefined): string {
  const mapping = container?.ports.find((p) => p.host === port && p.protocol === "tcp");
  return appOpenUrl({ port, containerPort: mapping?.container, webUi: container?.webUi ?? null });
}

function showOutcomeToast(outcome: LifecycleOutcome) {
  const options = outcome.description ? { description: outcome.description } : undefined;
  if (outcome.kind === "success") toast.success(outcome.title, options);
  else if (outcome.kind === "warning") toastWarning(outcome.title, options);
  else toast.error(outcome.title, options);
}

/** POST /api/stores/:storeId/apps/:appId/install-plan (admin only; null when unavailable). */
async function fetchInstallPlan(storeId: string, appId: string, options?: UmbrelInstallOptions): Promise<UmbrelInstallPlan | null> {
  try {
    const response = await talomePost<unknown>(
      `/api/stores/${encodeURIComponent(storeId)}/apps/${encodeURIComponent(appId)}/install-plan`,
      options ?? {},
    );
    return parseInstallPlan(response);
  } catch {
    return null;
  }
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
  const [actionLoading, setActionLoading] = useState<LifecycleAction | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [volumeValues, setVolumeValues] = useState<Record<string, string>>({});
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
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [umbrelDialog, setUmbrelDialog] = useState<{ plan: UmbrelInstallPlan; version: number } | null>(null);
  const [dismissedOps, setDismissedOps] = useState<Set<string>>(() => (typeof window === "undefined" ? new Set() : readDismissed()));
  const quickLook = useQuickLook();
  const confirm = useConfirm();
  const { isAdmin, isLoading: userLoading, hasPermission } = useUser();

  const appKey = storeId && appId ? `${CORE_URL}/api/apps/${storeId}/${appId}` : null;
  const stacksKey = `${CORE_URL}/api/containers?grouped=true`;
  const updatesKey = `${CORE_URL}/api/updates/${appId}`;

  // Whenever any operation on this app finishes (from this page, the
  // assistant, an automation…), refresh everything it may have changed.
  const onOperationSettled = useCallback(
    (event: OperationEvent) => {
      if (appKey) void globalMutate(appKey);
      void globalMutate(stacksKey);
      void globalMutate(updatesKey);
      if (event.kind !== "uninstall") void globalMutate(verificationUrl("app", appId));
    },
    [appKey, stacksKey, updatesKey, appId],
  );

  // Live operation (SSE) + recent history from the operations journal.
  const operations = useAppOperations(appId, { busy: !!actionLoading, onSettled: onOperationSettled });
  const liveOperation = operations.isActive ? operations.live : null;
  // A failed / interrupted / rolled-back operation stays in the primary slot
  // until it is retried, dismissed, or superseded by a newer operation.
  const settledFailure = operations.isActive ? null : settledFailureFrom(operations.live, operations.history, dismissedOps);
  const dismissFailure = useCallback((operationId: string) => {
    setDismissedOps((prev) => {
      const next = new Set(prev);
      next.add(operationId);
      writeDismissed(next);
      return next;
    });
  }, []);

  // Poll fast (5s) only while an action / operation is in flight (plus a short
  // grace window to catch the settled state); otherwise every 30s.
  const actionInFlight = !!actionLoading || operations.isActive;
  const actionPollMs = useAdaptiveInterval(actionInFlight, {
    fast: POLL_ACTIVE_MS,
    slow: POLL_IDLE_MS,
    graceMs: ACTION_GRACE_MS,
  });

  // Stable refreshInterval functions: SWR restarts its poll timer whenever
  // the function identity changes, so inline closures would starve polling
  // while SSE progress / editor state re-renders the page.
  const appRefreshInterval = useCallback(
    (data: CatalogApp | undefined) => {
      if (!data?.installed) return actionInFlight ? POLL_ACTIVE_MS : 0;
      return isTransitionalInstallStatus(data.installed.status) ? POLL_ACTIVE_MS : actionPollMs;
    },
    [actionPollMs, actionInFlight],
  );

  const { loadedAt: appLoadedAt, markLoaded: markAppLoaded } = useLoadedAt();
  const { data: app, error: appError, isLoading, isValidating: appValidating, mutate } = useSWR<AppDetail>(
    appKey,
    fetcher,
    {
      refreshInterval: appRefreshInterval,
      onSuccess: (data) => {
        markAppLoaded();
        if (!data.installed && Object.keys(envValues).length === 0) {
          const defaults: Record<string, string> = {};
          data.env?.forEach((e: { key: string; default?: string }) => {
            if (e.default) defaults[e.key] = e.default;
          });
          if (Object.keys(defaults).length > 0) setEnvValues(defaults);
        }
      },
      revalidateOnFocus: false,
      // A 404 is an answer, not a blip: don't keep asking.
      shouldRetryOnError: (err: unknown) => fetchErrorStatus(err) !== 404,
    },
  );
  const loadingPhase = useLoadingPhase(isLoading && !app);

  // Fetch service stacks to find containers for this app
  const appTransitional = isTransitionalInstallStatus(app?.installed?.status);
  const stacksRefreshInterval = useCallback(
    (data: ServiceStack[] | undefined) => {
      const stack = data?.find((s) => s.appId === appId || s.id === appId);
      const containersSettling = stack?.containers.some((c) => c.status === "restarting") ?? false;
      return appTransitional || containersSettling ? POLL_ACTIVE_MS : actionPollMs;
    },
    [appId, appTransitional, actionPollMs],
  );
  const { data: stacks } = useSWR<ServiceStack[]>(
    stacksKey,
    fetcher,
    {
      refreshInterval: stacksRefreshInterval,
      revalidateOnFocus: false,
    },
  );
  const appStack = stacks?.find((s) => s.appId === appId || s.id === appId);

  // Fetch available update info for this app (+ the last update/rollback result)
  const { data: updateInfo, mutate: mutateUpdateInfo } = useSWR<{
    currentVersion: string;
    availableVersion: string;
    hasUpdate: boolean;
    releaseNotes: string | null;
    lastUpdateOperation?: unknown;
  }>(
    app?.installed ? updatesKey : null,
    fetcher,
    { refreshInterval: 5 * 60 * 1000, revalidateOnFocus: false },
  );
  const lastUpdate = summarizeUpdateOperation(updateInfo?.lastUpdateOperation ?? null);

  // Umbrel apps: preview the install plan (folders, env choices, dependency
  // providers, unsupported reasons). The endpoint is admin-only; members
  // install with the server's defaults.
  const wantsInstallPlan = !!app && app.source === "umbrel" && !app.installed && isAdmin;
  const { data: installPlan, mutate: mutateInstallPlan } = useSWR<UmbrelInstallPlan | null>(
    wantsInstallPlan ? ["umbrel-install-plan", storeId, appId] : null,
    () => fetchInstallPlan(storeId, appId),
    { revalidateOnFocus: false },
  );
  const installBlocked = installBlockReason(installPlan);
  // Hold Install until we know whether to show the plan: while the role is
  // loading an early click would skip the dialog (and the unsupported check).
  const installPlanPending =
    !!app && app.source === "umbrel" && !app.installed && (userLoading || (wantsInstallPlan && installPlan === undefined));
  // Unsupported (e.g. Tor-only) apps can't be installed by any path, including the assistant.
  const installUnsupported = !!installPlan && !installPlan.supported;

  // Set title synchronously from URL, update when SWR data arrives.
  const resolvedName = app?.installed?.displayName || app?.name;
  useEffect(() => {
    setPageTitle(
      resolvedName ??
        appId.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    );
    return () => setPageTitle(null);
  }, [resolvedName, appId, setPageTitle]);

  const ACTION_SUCCESS: Record<Exclude<LifecycleAction, "uninstall">, string> = {
    install: "installed",
    start: "started",
    stop: "stopped",
    restart: "restarted",
    update: "updated",
  };

  /**
   * Another operation owns the app (409): adopt it so its progress shows in
   * the primary slot, and say what is happening in people's words.
   * Returns false when the error was not a conflict.
   */
  const showConflict = async (err: TalomeApiError): Promise<boolean> => {
    const conflict = parseOperationConflict(err.status, err.body);
    if (!conflict || !app) return false;
    const adopted: OperationRecord | null = conflict.operationId ? await operations.adopt(conflict.operationId) : null;
    const copy = describeOperationConflict(
      app.installed?.displayName || app.name,
      adopted ? { kind: adopted.kind, actor: adopted.actor, startedAt: adopted.startedAt } : runningFromConflictBody(err.body),
    );
    toast.info(copy.title, { description: copy.description });
    return true;
  };

  const runAction = async (action: LifecycleAction, options: { umbrel?: UmbrelInstallOptions } = {}) => {
    if (!app) return;
    setActionLoading(action);
    try {
      if (action === "install") {
        await talomePost(`/api/apps/${storeId}/${appId}/install`, {
          env: envValues,
          volumeMounts: volumeValues,
          ...(options.umbrel ? { umbrel: options.umbrel } : {}),
        });
        await mutate();
        toast.success(`${app.name} installed`);
      } else if (action === "update") {
        const response = await talomePost<unknown>(`/api/apps/${storeId}/${appId}/update`);
        const [, freshInfo] = await Promise.all([mutate(), mutateUpdateInfo()]);
        const operationId =
          response && typeof response === "object" && typeof (response as { operationId?: unknown }).operationId === "string"
            ? (response as { operationId: string }).operationId
            : null;
        // The route only returns `verified`; the journal knows "already up to date".
        const outcome = updateOutcomeFromOperation(freshInfo?.lastUpdateOperation ?? null, operationId);
        showOutcomeToast(describeUpdateResponse(app.name, 200, response, { outcome }));
      } else {
        if (action === "uninstall") return; // always through confirmUninstall()
        await talomePost(`/api/apps/${storeId}/${appId}/${action}`);
        await mutate();
        toast.success(`${app.name} ${ACTION_SUCCESS[action]}`);
      }
    } catch (err) {
      const conflict = err instanceof TalomeApiError ? await showConflict(err) : false;
      if (conflict) {
        // Shown: another operation owns the app, and its progress is now on the page.
      } else if (action === "update" && err instanceof TalomeApiError) {
        await Promise.all([mutate(), mutateUpdateInfo()]);
        showOutcomeToast(describeUpdateResponse(app.name, err.status, err.body));
      } else {
        toast.error(`Couldn't ${action} ${app.name}`, {
          description: err instanceof Error ? err.message : "Check that the Talome server is reachable, then retry.",
        });
        if (action === "install") void mutate();
      }
    } finally {
      setActionLoading(null);
      void operations.refresh();
    }
  };

  /** Install, first asking for Umbrel folder/env/dependency choices when the plan has any. */
  const startInstall = async () => {
    if (!app || installPlanPending) return;
    if (app.source === "umbrel" && isAdmin) {
      const plan = installPlan ?? (await mutateInstallPlan());
      if (plan && (planHasChoices(plan) || installBlockReason(plan))) {
        setUmbrelDialog((prev) => ({ plan, version: (prev?.version ?? 0) + 1 }));
        return;
      }
    }
    void runAction("install");
  };

  /**
   * Uninstall behind a destructive confirmation. "Keep app data" is on by
   * default; turning it off also erases the app's data folder once its
   * containers are gone. The dialog runs the request, so a failure (or a
   * conflict) shows inline with Retry instead of closing silently.
   */
  const confirmUninstall = async () => {
    if (!app) return;
    const name = app.installed?.displayName || app.name;
    const dataDir = `~/.talome/app-data/${appId}`;
    await confirm<{ dataKept?: boolean; dataRemoved?: boolean; dataError?: string }>({
      tier: "destructive",
      title: `Uninstall ${name}?`,
      consequence: `${name} stops and its containers are removed. Anything that depends on it stops working.`,
      recovery: `With "Keep app data" on, its settings and data stay in ${dataDir}, so reinstalling picks up where it left off. Folders it used on your drives are never touched.`,
      confirmLabel: `Uninstall ${name}`,
      option: {
        label: "Keep app data",
        defaultChecked: true,
        description: `Turn off to also erase ${dataDir}. That can't be undone.`,
      },
      busyLabel: `Uninstalling ${name}…`,
      run: async ({ optionChecked }) => {
        setActionLoading("uninstall");
        try {
          const result = await talomeDelete<{ dataKept?: boolean; dataRemoved?: boolean; dataError?: string }>(
            `/api/apps/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}${optionChecked ? "" : "?keepData=false"}`,
          );
          await mutate();
          if (result?.dataError) toastWarning(result.dataError);
          return result ?? {};
        } catch (err) {
          if (err instanceof TalomeApiError) {
            const conflict = parseOperationConflict(err.status, err.body);
            if (conflict) {
              const adopted = conflict.operationId ? await operations.adopt(conflict.operationId) : null;
              const copy = describeOperationConflict(
                name,
                adopted ? { kind: adopted.kind, actor: adopted.actor, startedAt: adopted.startedAt } : runningFromConflictBody(err.body),
              );
              throw new Error(`${copy.title}. ${copy.description}`);
            }
          }
          throw new Error(`Couldn't uninstall ${name}: ${err instanceof Error ? err.message : "the server didn't answer"}. Retry, or ask Talome to diagnose it.`);
        } finally {
          setActionLoading(null);
          void operations.refresh();
        }
      },
      // The server says what happened to the data folder; nothing is claimed it didn't confirm.
      receipt: (result) =>
        result.dataRemoved
          ? `Uninstalled ${name} · data erased`
          : result.dataKept
            ? `Uninstalled ${name} · data kept`
            : `Uninstalled ${name}`,
    });
  };

  /** Stop is a reversible disruption: a soft confirmation. */
  const confirmStop = async () => {
    if (!app) return;
    const name = app.installed?.displayName || app.name;
    const { confirmed } = await confirm({
      tier: "soft",
      title: `Stop ${name}?`,
      consequence: `${name} is unavailable until you start it again.`,
      recovery: "Nothing is deleted. Start it any time.",
      confirmLabel: `Stop ${name}`,
    });
    if (confirmed) void runAction("stop");
  };

  const confirmUmbrelInstall = async (options: UmbrelInstallOptions | undefined): Promise<string[] | null> => {
    if (options) {
      // Re-plan with the choices so invalid folders/values are reported here,
      // not as a failed install.
      const checked = await fetchInstallPlan(storeId, appId, options);
      const reason = installBlockReason(checked);
      if (checked && reason) return checked.blockers.length > 0 ? checked.blockers : [reason];
    }
    setUmbrelDialog(null);
    void runAction("install", { umbrel: options });
    return null;
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
  const pageReady = !!app;

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;
      // Talome's own actions (Open, the app's own interface) are not
      // "external links": only links from store content are intercepted.
      if (anchor.hasAttribute("data-trusted-link")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("/") || href.startsWith("#")) return;
      e.preventDefault();
      e.stopPropagation();
      setExternalUrl(href);
    };
    el.addEventListener("click", handler, true); // capture phase
    return () => el.removeEventListener("click", handler, true);
    // The page root only exists once the app has loaded (the first render is
    // the loading state), so attach then — with [] it never attached.
  }, [pageReady]);

  if (!app && !appError) {
    // Nothing for the first 200ms, so a fast load never flashes a skeleton.
    if (loadingPhase !== "skeleton") return <div className="mx-auto w-full max-w-xl min-h-96" aria-busy="true" />;
    return (
      <div className="mx-auto w-full max-w-xl grid gap-8 pt-2 pb-12" aria-busy="true">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="size-20 rounded-2xl" />
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-10 w-full max-w-xs mx-auto rounded-md" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    );
  }

  if (!app) {
    const status = fetchErrorStatus(appError);
    if (status === 404) {
      return (
        <div className="mx-auto w-full max-w-xl pt-8 pb-12">
          <EmptyState
            icon={Package01Icon}
            title="App not found"
            description="This store doesn't list this app any more. It may have been renamed or removed from the store."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href="/dashboard/apps">Back to App Store</Link>
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="mx-auto w-full max-w-xl pt-8 pb-12">
        <ErrorState
          title="Couldn't load this app"
          description="Check that the Talome server is reachable, then retry."
          onRetry={() => void mutate()}
        />
      </div>
    );
  }

  const isInstalled = !!app.installed;
  const installedFrom = !isInstalled ? app.installedFrom : undefined;
  const status = app.installed?.status;
  const isRunning = status === "running";
  const statusInfo = statusLabel(status);
  const displayName = app.installed?.displayName || app.name;
  const originalWebPort = app.webPort ?? (appStack ? getContainerWebPort(appStack.primaryContainer) : undefined);
  const openUrl = originalWebPort ? openUrlFor(originalWebPort, appStack?.primaryContainer) : null;
  const canAskTalome = hasPermission("chat");
  const realIconUrl = resolveApplicationIconUrl(app.iconUrl);
  const isUserCreated = storeId === "user-apps";
  const requiresSetup = !isInstalled && !installUnsupported && needsAiSetup(app);
  const retryFailure = (() => {
    if (!settledFailure) return undefined;
    switch (settledFailure.kind) {
      case "install":
        // Setup-first apps, blocked or unsupported installs and another
        // store's copy can't simply run again: Ask Talome stays available.
        return isInstalled || installedFrom || requiresSetup || installBlocked || installUnsupported
          ? undefined
          : () => void startInstall();
      case "update":
        return isInstalled ? () => void runAction("update") : undefined;
      case "uninstall":
        return isInstalled ? () => void confirmUninstall() : undefined;
      case "start":
      case "stop":
      case "restart":
        return isInstalled ? () => void runAction(settledFailure.kind as LifecycleAction) : undefined;
      default:
        return undefined;
    }
  })();
  const validScreenshots = (app.screenshots || []).filter(
    (s) => !s.startsWith("file://"),
  );
  const coverImage = app.coverUrl && !app.coverUrl.startsWith("file://") && !coverFailed ? app.coverUrl : undefined;
  const previewImages = coverImage
    ? [coverImage, ...validScreenshots.filter((url) => url !== coverImage)]
    : validScreenshots;

  return (
    <div ref={pageRef} className={`mx-auto w-full max-w-xl grid gap-10 pb-12${coverImage ? " pt-0" : " pt-2"}`}>
      {appError && (
        <StaleRow loadedAt={appLoadedAt} subject="details" onRetry={() => void mutate()} retrying={appValidating} className="justify-center" />
      )}
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
            {realIconUrl ? (
              <Image
                src={realIconUrl}
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
            <HugeiconsIcon
              icon={resolveApplicationIcon(app.icon, app.name)}
              size={32}
              className={realIconUrl ? "hidden text-dim-foreground" : "text-dim-foreground"}
            />
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
          {editingName && isInstalled ? (
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
                  setEditingName(false);
                } catch (err) {
                  toast.error(`Couldn't rename ${currentName}`, {
                    description: err instanceof Error ? err.message : "Check that the Talome server is reachable, then retry.",
                  });
                } finally { setSavingPatch(false); }
              }}
            >
              <Input
                autoFocus
                aria-label="App name"
                maxLength={100}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="h-8 text-center text-lg font-medium w-48"
                onKeyDown={(e) => { if (e.key === "Escape") setEditingName(false); }}
              />
              <Button size="sm" type="submit" busy={savingPatch} busyLabel="Saving name…">
                Save
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setEditingName(false)} disabled={savingPatch}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex items-center justify-center gap-1">
              <h1 className="text-2xl font-medium tracking-tight">{displayName}</h1>
              {/* Renaming applies to an installed app only (core answers 409 otherwise). */}
              {isInstalled && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={`Rename ${displayName}`}
                  title="Rename"
                  onClick={() => {
                    setDraftName(displayName);
                    setEditingName(true);
                  }}
                >
                  <HugeiconsIcon icon={Edit02Icon} size={14} />
                </Button>
              )}
            </div>
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
            <span className="app-detail-tag app-detail-tag--muted flex items-center gap-1.5">
              <StatusDot state={statusInfo.state} label={statusInfo.label} size="sm" hideLabel />
              <span aria-hidden="true">{statusInfo.label}</span>
            </span>
          )}
        </div>

        {/* Update available banner */}
        {updateInfo?.hasUpdate && status !== "updating" && !liveOperation && !settledFailure && (
          <div className="w-full max-w-sm rounded-xl border border-border bg-muted/30 px-4 py-3 grid gap-2">
            <div className="flex items-center gap-2.5">
              <HugeiconsIcon icon={SystemUpdate01Icon} size={16} className="text-muted-foreground shrink-0" />
              <p className="text-sm">
                <span className="text-muted-foreground">Update available: </span>
                <span className="font-medium">v{updateInfo.currentVersion}</span>
                <span className="text-muted-foreground"> → </span>
                <span className="font-medium">v{updateInfo.availableVersion}</span>
              </p>
            </div>
            {updateInfo.releaseNotes && (
              <p className="text-xs text-muted-foreground leading-relaxed pl-6 line-clamp-2">
                {updateInfo.releaseNotes}
              </p>
            )}
            <div className="pl-6">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => runAction("update")}
                disabled={actionInFlight && actionLoading !== "update"}
                busy={actionLoading === "update"}
                busyLabel={`Updating ${displayName}…`}
              >
                Update now
              </Button>
            </div>
          </div>
        )}

        {/* Primary action */}
        <div className="w-full max-w-xs grid gap-2 pt-1 place-items-center">
          {liveOperation ? (
            <OperationProgress operation={liveOperation} />
          ) : actionLoading === "install" ? (
            <Button size="lg" className="w-full" busy busyLabel={`Installing ${displayName}…`}>
              Install
            </Button>
          ) : settledFailure ? (
            <OperationFailure
              operation={settledFailure}
              appName={displayName}
              onRetry={retryFailure}
              retryBusy={actionInFlight}
              canAskTalome={canAskTalome}
              onDismiss={() => dismissFailure(settledFailure.operationId)}
            />
          ) : installedFrom ? (
            <Button size="lg" className="w-full" asChild>
              <Link href={`/dashboard/apps/${encodeURIComponent(installedFrom.storeId)}/${encodeURIComponent(appId)}`}>
                Open installed copy
              </Link>
            </Button>
          ) : isInstalled ? (
            <>
              {isRunning && app.nativeSurface ? (
                <>
                  <Button size="lg" className="w-full" asChild>
                    <Link href={`/dashboard/native-apps/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}`}>
                      Open {app.name}
                    </Link>
                  </Button>
                  {openUrl ? (
                    <Button variant="outline" className="w-full" asChild>
                      <a
                        href={openUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-trusted-link
                      >
                        Open original interface
                      </a>
                    </Button>
                  ) : null}
                </>
              ) : isRunning && openUrl ? (
                <Button size="lg" className="w-full" asChild>
                  <a
                    href={openUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-trusted-link
                  >
                    Open {displayName}
                  </a>
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => (isRunning ? void confirmStop() : void runAction("start"))}
                  disabled={actionInFlight && actionLoading !== "start" && actionLoading !== "stop"}
                  busy={actionLoading === "start" || actionLoading === "stop"}
                  busyLabel={actionLoading === "stop" ? `Stopping ${displayName}…` : `Starting ${displayName}…`}
                >
                  {isRunning ? "Stop" : "Start"}
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
              onClick={() => void startInstall()}
              disabled={actionInFlight || !!installBlocked || installPlanPending}
              className="w-full"
            >
              {app.detectedRunning ? "Reinstall with Talome" : "Install"}
            </Button>
          )}
          {installedFrom && !liveOperation && !settledFailure && (
            <p className="text-xs text-muted-foreground text-center">
              Installed from {installedFrom.storeName}. One copy of an app can be installed at a time.
            </p>
          )}
          {!isInstalled && !installedFrom && !requiresSetup && installBlocked && !liveOperation && !settledFailure && (
            <p className="text-xs text-status-critical text-center break-words" role="alert">
              {installBlocked}
            </p>
          )}
          {requiresSetup && (
            <p className="text-xs text-muted-foreground text-center">
              This app needs configuration before it can run
            </p>
          )}
          {!isInstalled && !installedFrom && !requiresSetup && app.detectedRunning && (
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
      {app.installNotes && !isInstalled && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Before you install
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
          <h2 className="text-sm font-medium text-muted-foreground">
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
          <h2 className="text-sm font-medium text-muted-foreground">
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
            <h2 className="text-sm font-medium text-muted-foreground">
              Media libraries
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
        <h2 className="text-sm font-medium text-muted-foreground">
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
              {editingPorts && isInstalled ? (
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
                      setEditingPorts(false);
                      if (res.portMessage) toast.success(res.portMessage);
                    } catch (err) {
                      if (!(err instanceof TalomeApiError && (await showConflict(err)))) {
                        toast.error("Couldn't change the ports", {
                          description: err instanceof Error ? err.message : "Check that the Talome server is reachable, then retry.",
                        });
                      }
                    } finally { setSavingPatch(false); }
                  }}
                >
                  {app.ports.map((p) => (
                    <div key={p.container} className="flex items-center gap-1">
                      <Input
                        inputMode="numeric"
                        aria-label={`Host port for container port ${p.container}`}
                        value={draftPorts[String(p.container)] ?? String(p.host)}
                        onChange={(e) => setDraftPorts((prev) => ({ ...prev, [String(p.container)]: e.target.value }))}
                        className="h-7 w-16 text-xs font-mono text-center"
                      />
                      <span className="text-muted-foreground text-xs">:{p.container}</span>
                    </div>
                  ))}
                  <Button size="xs" type="submit" busy={savingPatch} busyLabel="Saving ports…">
                    Save
                  </Button>
                  <Button size="xs" variant="ghost" type="button" onClick={() => setEditingPorts(false)} disabled={savingPatch}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="flex gap-1.5 flex-wrap justify-end items-center">
                  {app.ports.map((p, i) => (
                    <span key={i} className="port-chip">
                      {p.host}:{p.container}
                    </span>
                  ))}
                  {/* Port edits apply to an installed app only (core answers 409 otherwise). */}
                  {isInstalled && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      aria-label="Change ports"
                      title="Change ports"
                      disabled={actionInFlight}
                      onClick={() => {
                        const draft: Record<string, string> = {};
                        for (const p of app.ports) draft[String(p.container)] = String(p.host);
                        setDraftPorts(draft);
                        setEditingPorts(true);
                      }}
                    >
                      <HugeiconsIcon icon={Edit02Icon} size={12} />
                    </Button>
                  )}
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
            <h2 className="text-sm font-medium text-muted-foreground">
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
                  Continue customizing this app. Claude remembers the workspace from when it was created.
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
            <h2 className="text-sm font-medium text-muted-foreground">
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
                {submittingCommunity ? "Submitting…" : "Submit to community"}
              </Button>
            </div>
          </section>
        </>
      )}

      {/* ── Containers ──────────────────────────────────── */}
      {appStack && appStack.containers.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
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
                      <StatusDot state={statusLabel(container.status).state} label={statusLabel(container.status).label} size="sm" hideLabel />
                      <span className="text-sm font-medium truncate">{container.name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{statusLabel(container.status).label}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <code className="bg-muted px-1.5 py-0.5 rounded truncate max-w-60">{container.image}</code>
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

      {/* ── Outcome verification (installed only) ────────── */}
      <VerificationPanel target="app" id={appId} enabled={isInstalled} />

      {/* ── Last update result + recent operations ─────── */}
      <OperationActivity lastUpdate={isInstalled ? lastUpdate : null} history={operations.history} />

      {/* ── Lifecycle controls (installed only) ────────── */}
      {isInstalled && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Controls
          </h2>
          {liveOperation && (
            <p className="text-xs text-muted-foreground px-1">
              Controls are unavailable until the current {OPERATION_KIND_LABELS[liveOperation.kind].toLowerCase()} finishes.
            </p>
          )}
          <div className="rounded-xl border border-border divide-y divide-border">
            <button
              onClick={() => runAction("restart")}
              disabled={actionInFlight}
              className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <span>Restart</span>
              {actionLoading === "restart" && (
                <span className="text-muted-foreground text-xs">Restarting…</span>
              )}
            </button>
            <button
              onClick={async () => {
                setCheckingUpdates(true);
                try {
                  const fresh = await mutateUpdateInfo();
                  if (fresh?.hasUpdate) {
                    toast(`Update available: v${fresh.currentVersion} → v${fresh.availableVersion}`);
                  } else {
                    toast("Already on the latest version");
                  }
                } catch {
                  toast.error("Couldn't check for updates", { description: "Check that the Talome server is reachable, then retry." });
                } finally {
                  setCheckingUpdates(false);
                }
              }}
              disabled={actionInFlight || checkingUpdates}
              className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <span>Check for updates</span>
              {checkingUpdates && (
                <span className="text-muted-foreground text-xs">Checking…</span>
              )}
            </button>
            {updateInfo?.hasUpdate && (
              <button
                onClick={() => runAction("update")}
                disabled={actionInFlight}
                className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <span>Update to v{updateInfo.availableVersion}</span>
                {actionLoading === "update" && (
                  <span className="text-muted-foreground text-xs">Updating…</span>
                )}
              </button>
            )}
            {isRunning ? (
              <button
                onClick={() => void confirmStop()}
                disabled={actionInFlight}
                className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <span>Stop</span>
                {actionLoading === "stop" && (
                  <span className="text-muted-foreground text-xs">Stopping…</span>
                )}
              </button>
            ) : (
              <button
                onClick={() => runAction("start")}
                disabled={actionInFlight}
                className="w-full flex justify-between items-center px-4 py-3 text-sm hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <span>Start</span>
                {actionLoading === "start" && (
                  <span className="text-muted-foreground text-xs">Starting…</span>
                )}
              </button>
            )}
            <button
              onClick={() => void confirmUninstall()}
              disabled={actionInFlight}
              className="w-full flex justify-between items-center px-4 py-3 text-sm text-status-critical hover:bg-status-critical/5 transition-colors disabled:opacity-50"
            >
              <span>Uninstall…</span>
              {actionLoading === "uninstall" && (
                <span className="text-xs text-muted-foreground">Uninstalling…</span>
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
      {umbrelDialog && (
        <UmbrelInstallDialog
          key={umbrelDialog.version}
          open
          onOpenChange={(open) => { if (!open) setUmbrelDialog(null); }}
          appName={app.name}
          plan={umbrelDialog.plan}
          onConfirm={confirmUmbrelInstall}
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
