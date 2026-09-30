"use client";

import Image from "next/image";
import { useCallback, useState, useMemo } from "react";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useInstalledApps } from "@/hooks/use-installed-apps";
import { CORE_URL } from "@/lib/constants";
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

export default function SharePage() {
  const { apps, isLoading } = useInstalledApps();
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
      if (!exportRes.ok) throw new Error("Export failed");
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
      if (!shareRes.ok) throw new Error("Stack capsule generation failed");
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
      toast.success("Portable stack code ready");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to generate share code"
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
      <div className="flex flex-col gap-3 py-12 px-4 max-w-2xl mx-auto">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4 max-w-md mx-auto text-center">
        <p className="text-sm text-muted-foreground">
          No apps installed yet. Install some apps first, then come back to
          share your setup.
        </p>
      </div>
    );
  }

  const allSelected =
    effectiveSelection.size === apps.length && apps.length > 0;

  return (
    <div className="flex flex-col px-4 py-8 sm:py-12 max-w-2xl mx-auto w-full">
      {/* Intro */}
      <div className="mb-8 sm:mb-10">
        <h2 className="text-lg font-medium tracking-tight">
          Share your setup
        </h2>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          Choose the apps to include. Talome packages their setup without
          secrets, passwords, or this server&apos;s address, and the recipient can
          review everything before installing.
        </p>
      </div>

      <section
        aria-labelledby="share-package-explainer"
        className="mb-8 overflow-hidden rounded-2xl border border-border bg-card"
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

        <div className="grid divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
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

        <p className="border-t border-border/70 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          The recipient imports the file in <span className="font-medium text-foreground">Settings → Export &amp; Import</span>,
          reviews the apps, then Talome helps configure and install them. Your server does not need to stay online.
        </p>
      </section>

      {/* App selector */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-muted-foreground">
            {effectiveSelection.size} of {apps.length} app
            {apps.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={allSelected ? selectNone : selectAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {apps.map((app) => {
            const selected = effectiveSelection.has(app.id);
            return (
              <button
                key={app.id}
                onClick={() => toggleApp(app.id)}
                className={`group relative flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all ${
                  selected
                    ? "bg-card border border-border"
                    : "bg-transparent border border-transparent opacity-40 hover:opacity-70"
                }`}
              >
                <AppSelectorIcon app={app} />
                <span className="text-xs font-medium truncate min-w-0">
                  {app.name}
                </span>
                {selected && (
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    size={14}
                    className="ml-auto shrink-0 text-dim-foreground"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Generate button */}
      {!shareCode && (
        <Button
          onClick={() => void generateShareCode()}
          disabled={generating || effectiveSelection.size === 0}
          className="rounded-full self-start px-6"
          size="sm"
        >
          {generating ? "Preparing…" : "Prepare share package"}
        </Button>
      )}

      {/* Share code result */}
      <AnimatePresence>
        {shareCode && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            className="space-y-6"
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-start gap-3 border-b border-border/70 p-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                  <HugeiconsIcon icon={Tick01Icon} size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Recipe ready to share</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {selectedApps.length} app{selectedApps.length === 1 ? "" : "s"} packaged safely for another Talome server.
                  </p>
                </div>
                {fingerprint && (
                  <code className="shrink-0 rounded-md bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground">
                    ID {fingerprint}
                  </code>
                )}
              </div>
              <div className="p-4">
                <div className="relative overflow-hidden rounded-xl border border-border/70 bg-muted/25">
                  <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-medium text-muted-foreground">Portable code</span>
                    <span className="text-[10px] text-muted-foreground">{shareCode.length.toLocaleString()} characters</span>
                  </div>
                  <code className="block max-h-16 overflow-hidden break-all px-3 py-2.5 font-mono text-[11px] leading-5 text-muted-foreground [mask-image:linear-gradient(to_bottom,black_45%,transparent_100%)]">
                    {shareCode}
                  </code>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Button size="sm" onClick={() => void copyCode()} className="h-9 w-full gap-1.5 rounded-lg text-xs">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={copiedState ? "copied" : "copy"}
                        initial={{ opacity: 0, y: 2 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -2 }}
                        transition={{ duration: 0.14 }}
                        className="flex items-center gap-1.5"
                      >
                        <HugeiconsIcon icon={copiedState ? Tick01Icon : Copy01Icon} size={13} />
                        {copiedState ? "Copied" : "Copy code"}
                      </motion.span>
                    </AnimatePresence>
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void shareRecipe()} className="h-9 w-full gap-1.5 rounded-lg text-xs">
                    <HugeiconsIcon icon={Share04Icon} size={13} /> Share recipe
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadRecipe} className="h-9 w-full gap-1.5 rounded-lg text-xs">
                    <HugeiconsIcon icon={Download01Icon} size={13} /> Download
                  </Button>
                </div>

                <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
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
                    className="h-7 gap-1.5 text-xs rounded-full px-4"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={linkCopied ? "check" : "copy"}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.15 }}
                        className="flex items-center gap-1.5"
                      >
                        <HugeiconsIcon icon={linkCopied ? Tick01Icon : Copy01Icon} size={12} />
                        {linkCopied ? "Copied" : "Copy link"}
                      </motion.span>
                    </AnimatePresence>
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs rounded-full px-4" asChild>
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
                <Button size="sm" variant="outline" onClick={downloadRecovery} className="mt-3 h-8 gap-1.5 rounded-full px-4 text-xs">
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
    <div className="flex gap-2.5 p-4 sm:flex-col sm:gap-2">
      <HugeiconsIcon
        icon={icon}
        size={15}
        className="mt-0.5 shrink-0 text-muted-foreground sm:mt-0"
      />
      <div>
        <p className="text-xs font-medium">{title}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
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
