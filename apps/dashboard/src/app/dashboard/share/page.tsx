"use client";

import Image from "next/image";
import { useCallback, useState, useMemo } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  HugeiconsIcon,
  Copy01Icon,
  Tick01Icon,
  CheckmarkCircle01Icon,
  Package01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useInstalledApps } from "@/hooks/use-installed-apps";
import { CORE_URL } from "@/lib/constants";

export default function SharePage() {
  const { apps, isLoading } = useInstalledApps();
  const [selectedAppIds, setSelectedAppIds] = useState<Set<string> | null>(
    null
  );
  const [shareCode, setShareCode] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copiedState, setCopiedState] = useState(false);

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
    },
    [apps]
  );

  const selectAll = useCallback(() => {
    setSelectedAppIds(new Set(apps.map((a) => a.id)));
    setShareCode("");
  }, [apps]);

  const selectNone = useCallback(() => {
    setSelectedAppIds(new Set());
    setShareCode("");
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

      const shareRes = await fetch(`${CORE_URL}/api/stacks/share-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stack }),
      });
      if (!shareRes.ok) throw new Error("Share link generation failed");
      const { shareCode: code } = (await shareRes.json()) as {
        shareCode: string;
      };

      setShareCode(code);
      toast.success("Share code generated");
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
    try {
      await navigator.clipboard.writeText(shareCode);
      setCopiedState(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedState(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, [shareCode]);

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
          Generate a share code for your app stack. Others can import it on
          their Talome instance to replicate your setup. Secrets and API keys are
          never included.
        </p>
      </div>

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
          {generating ? "Generating..." : "Generate share code"}
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
            {/* Code display */}
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-2">Share code</p>
              <code className="text-xs font-mono text-muted-foreground break-all leading-relaxed block max-h-24 overflow-y-auto">
                {shareCode}
              </code>
              <div className="flex items-center gap-2 mt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void copyCode()}
                  className="h-7 gap-1.5 text-xs rounded-full px-4"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={copiedState ? "check" : "copy"}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.15 }}
                      className="flex items-center gap-1.5"
                    >
                      <HugeiconsIcon
                        icon={copiedState ? Tick01Icon : Copy01Icon}
                        size={12}
                      />
                      {copiedState ? "Copied" : "Copy"}
                    </motion.span>
                  </AnimatePresence>
                </Button>
              </div>
            </div>

            {/* Hint */}
            <p className="text-xs text-muted-foreground leading-relaxed">
              The recipient can import this code in Settings &rarr; Export &
              Import. They'll be prompted to fill in any secrets (API keys,
              passwords) before installing.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Helpers ── */

function AppSelectorIcon({
  app,
}: {
  app: { iconUrl?: string; icon?: string; name: string };
}) {
  const hasImage = app.iconUrl && !app.iconUrl.startsWith("file://");

  if (hasImage) {
    return (
      <Image
        src={app.iconUrl!}
        alt=""
        width={28}
        height={28}
        className="size-7 rounded-lg object-cover shrink-0"
      />
    );
  }

  if (app.icon && app.icon !== "📦") {
    return (
      <div className="size-7 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 text-sm leading-none">
        {app.icon}
      </div>
    );
  }

  return (
    <div className="size-7 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
      <HugeiconsIcon
        icon={Package01Icon}
        size={14}
        className="text-dim-foreground"
      />
    </div>
  );
}
