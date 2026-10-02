"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import {
  HugeiconsIcon,
  Copy01Icon,
  Download01Icon,
  Tick01Icon,
  CheckmarkCircle01Icon,
  HardDriveIcon,
  InformationCircleIcon,
  LinkSquare01Icon,
  Package01Icon,
  Share04Icon,
  Shield01Icon,
} from "@/components/icons";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { WindowStatusBar } from "@/components/desktop/window-content";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { StaleRow } from "@/components/data-state/data-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SelectMark } from "@/components/ui/micro";
import { useInstalledApps } from "@/hooks/use-installed-apps";
import { CORE_URL } from "@/lib/constants";
import { DURATION, TRAVEL, enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  buildPublicCapsuleUrl,
  downloadStackFile,
  shareStackFile,
  type StackCapsuleResponse,
} from "@/lib/stack-sharing";
import {
  resolveApplicationIcon,
  resolveApplicationIconUrl,
} from "@/components/native-app/native-app-icons";

/** The SWR key useInstalledApps reads, so Retry can revalidate it */
const INSTALLED_APPS_KEY = `${CORE_URL}/api/apps/installed`;
const countFormat = new Intl.NumberFormat();

export default function SharePage() {
  const embedded = useIsEmbeddedFrame();
  const { apps, isLoading, error } = useInstalledApps();
  const { mutate } = useSWRConfig();
  const [retrying, setRetrying] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetrying(true);
    try {
      await mutate(INSTALLED_APPS_KEY);
    } finally {
      setRetrying(false);
    }
  }, [mutate]);
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string> | null>(
    null
  );
  const [shareCode, setShareCode] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [recipeFileCode, setRecipeFileCode] = useState("");
  const [recipeFileName, setRecipeFileName] = useState("talome-stack.talome-stack");
  const [recoveryFileCode, setRecoveryFileCode] = useState("");
  const [recoveryFileName, setRecoveryFileName] = useState("talome-stack.talome-recovery");
  const [missingCatalogApps, setMissingCatalogApps] = useState<string[]>([]);
  const [linkFallbackReason, setLinkFallbackReason] = useState<"not-configured" | "too-large" | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copiedState, setCopiedState] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // Each package that arrives moves focus to its receipt (and scrolls it into
  // view): Prepare sits in the toolbar, the result below the app list.
  const [generation, setGeneration] = useState(0);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (generation > 0) resultHeadingRef.current?.focus();
  }, [generation]);

  // Default: all apps selected
  const effectiveSelection = useMemo(() => {
    if (selectedAppIds !== null) return selectedAppIds;
    return new Set(apps.map((a) => a.id));
  }, [selectedAppIds, apps]);

  const selectedApps = useMemo(
    () => apps.filter((a) => effectiveSelection.has(a.id)),
    [apps, effectiveSelection]
  );

  const toggleApp = useCallback(
    (id: string) => {
      setSelectedAppIds((prev) => {
        const next = new Set(prev ?? apps.map((a) => a.id));
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      // Clear generated code when selection changes
      setShareCode("");
      setShareUrl("");
      setRecipeFileCode("");
      setRecoveryFileCode("");
      setMissingCatalogApps([]);
      setLinkFallbackReason(null);
    },
    [apps]
  );

  const selectAll = useCallback(() => {
    setSelectedAppIds(new Set(apps.map((a) => a.id)));
    setShareCode("");
    setShareUrl("");
    setRecipeFileCode("");
    setRecoveryFileCode("");
    setMissingCatalogApps([]);
    setLinkFallbackReason(null);
  }, [apps]);

  const selectNone = useCallback(() => {
    setSelectedAppIds(new Set());
    setShareCode("");
    setShareUrl("");
    setRecipeFileCode("");
    setRecoveryFileCode("");
    setMissingCatalogApps([]);
    setLinkFallbackReason(null);
  }, []);

  const generateShareCode = useCallback(async () => {
    if (selectedApps.length === 0) return;
    setGenerating(true);
    try {
      // Export running apps as stack, then encode as share code
      const exportRes = await fetch(`${CORE_URL}/api/stacks/export-running`, {
        method: "POST",
      });
      if (!exportRes.ok) throw new Error("Couldn't read the running apps. Check that Talome is reachable, then try again.");
      const { stack } = (await exportRes.json()) as { stack: { apps: { appId: string }[] } };

      // Filter stack to only selected apps
      stack.apps = stack.apps.filter((a: { appId: string }) =>
        effectiveSelection.has(a.appId)
      );

      const shareRes = await fetch(`${CORE_URL}/api/stacks/share-capsule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stack }),
      });
      if (!shareRes.ok) throw new Error("Couldn't package the selected apps. Try again, or ask Talome if it keeps failing.");
      const result = (await shareRes.json()) as StackCapsuleResponse;

      const publicUrl = result.linkCompatible ? buildPublicCapsuleUrl(result.capsuleCode) : null;
      setShareCode(result.capsuleCode);
      setFingerprint(result.fingerprint);
      setShareUrl(publicUrl ?? "");
      setRecipeFileCode(result.recipeFileCode);
      setRecipeFileName(result.recipeFileName);
      setRecoveryFileCode(result.recoveryFileCode);
      setRecoveryFileName(result.recoveryFileName);
      setMissingCatalogApps(result.missingCatalogApps.map((app) => app.name));
      setLinkFallbackReason(publicUrl ? null : result.linkCompatible ? "not-configured" : "too-large");
      setGeneration((n) => n + 1);
      toast.success("Portable stack code ready");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't prepare the share package. Try again."
      );
    } finally {
      setGenerating(false);
    }
  }, [selectedApps, effectiveSelection]);

  const copyCode = useCallback(async () => {
    if (!shareCode) return;
    if (await copyText(shareCode)) {
      setCopiedState(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedState(false), 2000);
    } else {
      toast.error("Failed to copy");
    }
  }, [shareCode]);

  const copyLink = useCallback(async () => {
    if (!shareUrl) return;
    if (await copyText(shareUrl)) {
      setLinkCopied(true);
      toast.success("Share link copied");
      setTimeout(() => setLinkCopied(false), 2000);
    } else {
      toast.error("Failed to copy");
    }
  }, [shareUrl]);

  const downloadRecipe = useCallback(() => {
    if (!recipeFileCode) return;
    downloadStackFile(recipeFileCode, recipeFileName);
    toast.success("Recipe file downloaded");
  }, [recipeFileCode, recipeFileName]);

  const shareRecipe = useCallback(async () => {
    if (!recipeFileCode) return;
    try {
      const result = await shareStackFile(recipeFileCode, recipeFileName, "Talome stack recipe");
      toast.success(result === "shared" ? "Stack recipe shared" : "Recipe file downloaded");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Could not share stack file");
    }
  }, [recipeFileCode, recipeFileName]);

  const downloadRecovery = useCallback(() => {
    if (!recoveryFileCode) return;
    downloadStackFile(recoveryFileCode, recoveryFileName);
    toast.success("Recovery file downloaded");
  }, [recoveryFileCode, recoveryFileName]);

  if (isLoading) {
    return (
      <div className="@container mx-auto flex w-full max-w-2xl flex-col gap-3" aria-busy="true">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <div className="grid grid-cols-2 @lg:grid-cols-3 gap-2 mt-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // A failed load is an error, not "no apps" (stale data stays, with a Retry row)
  if (error && apps.length === 0) {
    return (
      <ErrorState
        fill
        title="Couldn't load your apps"
        description="Talome couldn't read which apps are installed. Check that the server is reachable, then retry."
        onRetry={() => void retryLoad()}
      />
    );
  }

  if (apps.length === 0) {
    return (
      <EmptyState
        fill
        icon={Package01Icon}
        title="No apps to share yet"
        description="Install some apps first, then come back to share your setup."
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/apps">Browse App Store</Link>
          </Button>
        }
      />
    );
  }

  const allSelected =
    effectiveSelection.size === apps.length && apps.length > 0;
  const countLabel = `${countFormat.format(effectiveSelection.size)} of ${countFormat.format(apps.length)} ${apps.length === 1 ? "app" : "apps"}`;

  return (
    // The shell pads the page (classic and window alike), so the page adds
    // none of its own. A size container: it lays out by its own width.
    <div className="@container mx-auto flex w-full max-w-2xl flex-col pb-6">
      {/* Intro */}
      <div className="mb-6">
        <h2 className="text-lg font-medium tracking-tight">
          Share your setup
        </h2>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          Choose the apps to include. Talome packages their setup without
          secrets, passwords, or this server&apos;s address, and the recipient can
          review everything before installing.
        </p>
      </div>

      {error && (
        <StaleRow loadedAt={null} subject="apps" onRetry={() => void retryLoad()} retrying={retrying} className="mb-3" />
      )}

      {/* The selection and the primary action: in a window, the toolbar row;
          in classic mode, the row right above the apps it acts on. */}
      <DesktopAppToolbar data-compact-toolbar="" className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        {!embedded && <span className="text-sm tabular-nums text-muted-foreground">{countLabel}</span>}
        <Button
          type="button"
          variant="ghost"
          size={embedded ? "icon-sm" : "sm"}
          aria-label={allSelected ? "Deselect all" : "Select all"}
          title={allSelected ? "Deselect all" : "Select all"}
          onClick={allSelected ? selectNone : selectAll}
          className="h-8 px-2 text-muted-foreground hover:text-foreground pointer-coarse:h-11"
        >
          {embedded ? <HugeiconsIcon icon={CheckmarkCircle01Icon} size={16} aria-hidden /> : allSelected ? "Deselect all" : "Select all"}
        </Button>
        <Button
          type="button"
          size="sm"
          // Once a package exists, copying it is the primary action
          variant={shareCode ? "outline" : "default"}
          onClick={() => void generateShareCode()}
          busy={generating}
          busyLabel={embedded ? "Preparing…" : "Preparing the share package…"}
          disabled={effectiveSelection.size === 0}
          // On a phone it wraps under the count and spans the row
          className={cn("ml-auto min-w-0 px-4 pointer-coarse:h-11", !embedded && "@max-sm:w-full")}
          aria-label={shareCode ? "Prepare again" : "Prepare share package"}
        >
          {embedded ? "Prepare" : shareCode ? "Prepare again" : "Prepare share package"}
        </Button>
      </DesktopAppToolbar>
      {embedded && <WindowStatusBar>{countLabel}</WindowStatusBar>}

      {/* App selector: each tile is a toggle */}
      <div role="group" aria-label="Apps to include" className="mb-8 grid grid-cols-2 gap-2 @lg:grid-cols-3">
        {apps.map((app) => {
          const selected = effectiveSelection.has(app.id);
          return (
            <button
              key={app.id}
              type="button"
              aria-pressed={selected}
              onClick={() => toggleApp(app.id)}
              className={cn(
                "flex min-h-12 min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors duration-150",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selected
                  ? "border-border bg-card text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <AppSelectorIcon app={app} />
              <span className="min-w-0 truncate text-sm font-medium">
                {app.name}
              </span>
              <SelectMark
                selected={selected}
                className={cn("ml-auto shrink-0", selected ? "text-foreground" : "text-muted-foreground")}
              />
            </button>
          );
        })}
      </div>

      {/* Share code result */}
      <AnimatePresence>
        {shareCode && (
          <motion.div
            initial={{ opacity: 0, y: TRAVEL.lift }}
            animate={{ opacity: 1, y: 0, transition: enter() }}
            exit={{ opacity: 0, y: TRAVEL.rise, transition: exit() }}
            className="mb-8 space-y-6"
          >
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-start gap-3 border-b border-border/70 p-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                  <HugeiconsIcon icon={Tick01Icon} size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 ref={resultHeadingRef} tabIndex={-1} className="text-sm font-medium outline-none">
                    Recipe ready to share
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {selectedApps.length} app{selectedApps.length === 1 ? "" : "s"} packaged safely for another Talome server.
                  </p>
                </div>
                {fingerprint && (
                  <code className="shrink-0 rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                    ID {fingerprint}
                  </code>
                )}
              </div>
              <div className="p-4">
                <div className="relative overflow-hidden rounded-xl border border-border/70 bg-muted/25">
                  <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">Portable code</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{shareCode.length.toLocaleString()} characters</span>
                  </div>
                  <code className="block max-h-16 overflow-hidden break-all px-3 py-2.5 font-mono text-xs leading-5 text-muted-foreground [mask-image:linear-gradient(to_bottom,black_45%,transparent_100%)]">
                    {shareCode}
                  </code>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 @lg:grid-cols-3">
                  <Button size="sm" onClick={() => void copyCode()} className="h-9 w-full gap-1.5 rounded-lg text-xs pointer-coarse:h-11">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={copiedState ? "copied" : "copy"}
                        initial={{ opacity: 0, y: TRAVEL.nudge }}
                        animate={{ opacity: 1, y: 0, transition: enter(DURATION.fast) }}
                        exit={{ opacity: 0, y: -TRAVEL.nudge, transition: exit(DURATION.exitFast) }}
                        className="flex items-center gap-1.5"
                      >
                        <HugeiconsIcon icon={copiedState ? Tick01Icon : Copy01Icon} size={13} />
                        {copiedState ? "Copied" : "Copy code"}
                      </motion.span>
                    </AnimatePresence>
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void shareRecipe()} className="h-9 w-full gap-1.5 rounded-lg text-xs pointer-coarse:h-11">
                    <HugeiconsIcon icon={Share04Icon} size={13} /> Share recipe
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadRecipe} className="h-9 w-full gap-1.5 rounded-lg text-xs pointer-coarse:h-11">
                    <HugeiconsIcon icon={Download01Icon} size={13} /> Download
                  </Button>
                </div>

                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <HugeiconsIcon icon={CheckmarkCircle01Icon} size={13} className="shrink-0" />
                  No secrets or app data included. The recipe works independently of this server&apos;s address.
                </p>
              </div>
            </div>

            {/* Optional public link display */}
            {shareUrl ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <HugeiconsIcon icon={LinkSquare01Icon} size={14} className="text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">VPN-independent preview</p>
                </div>
                <code className="text-xs font-mono text-foreground break-all leading-relaxed block max-h-24 overflow-y-auto">
                  {shareUrl}
                </code>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void copyLink()}
                    className="h-7 gap-1.5 text-xs rounded-full px-4 pointer-coarse:h-11"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={linkCopied ? "check" : "copy"}
                        initial={{ opacity: 0, y: TRAVEL.nudge }}
                        animate={{ opacity: 1, y: 0, transition: enter(DURATION.fast) }}
                        exit={{ opacity: 0, y: -TRAVEL.nudge, transition: exit(DURATION.exitFast) }}
                        className="flex items-center gap-1.5"
                      >
                        <HugeiconsIcon icon={linkCopied ? Tick01Icon : Copy01Icon} size={12} />
                        {linkCopied ? "Copied" : "Copy link"}
                      </motion.span>
                    </AnimatePresence>
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs rounded-full px-4 pointer-coarse:h-11" asChild>
                    <a href={shareUrl} target="_blank" rel="noopener noreferrer">Open preview</a>
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {linkFallbackReason === "too-large"
                  ? "A public preview would be unreliable for this package. Use the portable code or recipe file instead."
                  : "This package is ready to copy or download. Public preview links are not enabled on this build."}
              </p>
            )}

            {missingCatalogApps.length > 0 && (
              <div className="rounded-xl border border-status-warning/25 bg-status-warning/5 p-4">
                <p className="text-sm font-medium">Custom app recovery</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  The recipe cannot fully recreate {missingCatalogApps.join(", ")} because {missingCatalogApps.length === 1 ? "it is" : "they are"} not in the recipient&apos;s catalog. The recovery file contains sanitized Compose, but no app data; review it and share only with people you trust.
                </p>
                <Button size="sm" variant="outline" onClick={downloadRecovery} className="mt-3 h-8 gap-1.5 rounded-full px-4 text-xs pointer-coarse:h-11">
                  <HugeiconsIcon icon={Download01Icon} size={12} /> Download recovery file
                </Button>
              </div>
            )}

            {shareUrl && (
              <p className="text-xs text-muted-foreground leading-relaxed">
                The preview is self-contained and does not expire. Create a new package whenever your setup changes.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* What a share package is, for reference below the work */}
      <section
        aria-labelledby="share-package-explainer"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
            <HugeiconsIcon
              icon={InformationCircleIcon}
              size={15}
              className="text-muted-foreground"
            />
          </div>
          <div className="min-w-0">
            <h3 id="share-package-explainer" className="text-sm font-medium">
              Portable recipe, not a backup
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              It recreates the selected app setup on another Talome server. It
              does not copy databases, media, settings, or persistent app data.
            </p>
          </div>
        </div>

        <div className="grid divide-y divide-border/70 @lg:grid-cols-3 @lg:divide-x @lg:divide-y-0">
          <SharePackageFact
            icon={Package01Icon}
            title="Recipe"
            description="Safe to share. Contains app identities and required setup fields—never secrets or this server’s address."
          />
          <SharePackageFact
            icon={Shield01Icon}
            title="Recovery"
            description="Offered for custom apps. Includes sanitized Compose with credentials removed for review."
          />
          <SharePackageFact
            icon={HardDriveIcon}
            title="Backup"
            description="Use Talome backups separately when you need app data, libraries, and state preserved."
          />
        </div>

        <p className="border-t border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          The recipient imports the file in <span className="font-medium text-foreground">Settings → Export &amp; Import</span>,
          reviews the apps, then Talome helps configure and install them. Your server does not need to stay online.
        </p>
      </section>
    </div>
  );
}

/* ── Helpers ── */

function SharePackageFact({
  icon,
  title,
  description,
}: {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-2.5 p-4 @lg:flex-col @lg:gap-2">
      <HugeiconsIcon
        icon={icon}
        size={15}
        className="mt-0.5 shrink-0 text-muted-foreground @lg:mt-0"
      />
      <div>
        <p className="text-xs font-medium">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Clipboard permissions can be denied inside the desktop iframe.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function AppSelectorIcon({
  app,
}: {
  app: { iconUrl?: string; icon?: string; name: string };
}) {
  const iconUrl = resolveApplicationIconUrl(app.iconUrl);
  const fallbackIcon = resolveApplicationIcon(app.icon, app.name);

  if (iconUrl) {
    return (
      <Image
        src={iconUrl}
        alt=""
        width={28}
        height={28}
        className="size-7 rounded-lg object-cover shrink-0"
      />
    );
  }

  return (
    <div className="size-7 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
      <HugeiconsIcon
        icon={fallbackIcon}
        size={14}
        className="text-dim-foreground"
      />
    </div>
  );
}
