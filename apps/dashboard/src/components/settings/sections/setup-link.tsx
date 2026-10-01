"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  HugeiconsIcon,
  AiChat02Icon,
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Download01Icon,
  FileAttachmentIcon,
  Layers01Icon,
  Package01Icon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, copyToClipboard } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import {
  buildPublicCapsuleUrl,
  codeFromStackFile,
  downloadStackFile,
  type StackCapsuleResponse,
} from "@/lib/stack-sharing";
import { PENDING_STACK_IMPORT_KEY } from "@/lib/stack-import-bridge";

/* ── Types (for imported stack preview) ────────────────── */

interface ImportedStackApp {
  appId: string;
  name: string;
  description?: string;
  storeId?: string;
  available: boolean;
  installed: boolean;
  requiredInputCount: number;
}

interface ImportedStack {
  id: string;
  name: string;
  description: string;
  apps: ImportedStackApp[];
}

interface RequiredStackInput {
  appId: string;
  appName: string;
  key: string;
  description: string;
  secret: boolean;
}

interface StackImportPreview {
  valid: true;
  stack: ImportedStack;
  requiredInputs: RequiredStackInput[];
  summary: {
    installedCount: number;
    availableCount: number;
    missingCount: number;
    requiredInputCount: number;
  };
  message: string;
}

function buildAssistantPrompt(preview: StackImportPreview): string {
  const missingApps = preview.stack.apps.filter((app) => !app.installed && app.available);
  const installedApps = preview.stack.apps.filter((app) => app.installed);
  const unavailableApps = preview.stack.apps.filter((app) => !app.available);
  const requiredInputs = preview.requiredInputs.map((input) => `${input.appName}: ${input.key}`);

  const details = [
    missingApps.length > 0
      ? `Install from my catalog: ${missingApps.map((app) => `${app.name} (${app.storeId}/${app.appId})`).join(", ")}.`
      : "No catalog apps still need installation.",
    installedApps.length > 0
      ? `Already installed: ${installedApps.map((app) => app.name).join(", ")}.`
      : "",
    unavailableApps.length > 0
      ? `Not found in my catalog: ${unavailableApps.map((app) => app.name).join(", ")}; suggest safe alternatives before changing anything.`
      : "",
    requiredInputs.length > 0
      ? `Required configuration to request from me: ${requiredInputs.join(", ")}.`
      : "No required configuration fields were declared in the shared manifest.",
  ].filter(Boolean).join(" ");

  return `Help me recreate the shared Talome stack "${preview.stack.name}". ${details} Review the plan first, ask only for values that are actually required, never expose secrets, then install and configure the approved apps.`;
}

/* ── Component ─────────────────────────────────────────── */

export function ExportImportSection() {
  // Settings export
  const [generating, setGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState("");
  const [settingsCopied, setSettingsCopied] = useState(false);

  // Stack export
  const [exporting, setExporting] = useState(false);
  const [stackCapsuleCode, setStackCapsuleCode] = useState("");
  const [stackShareUrl, setStackShareUrl] = useState("");
  const [stackFileCode, setStackFileCode] = useState("");
  const [stackFileName, setStackFileName] = useState("talome-stack.talome-stack");
  const [stackRecoveryCode, setStackRecoveryCode] = useState("");
  const [stackRecoveryName, setStackRecoveryName] = useState("talome-stack.talome-recovery");
  const [stackHasCustomApps, setStackHasCustomApps] = useState(false);
  const [stackCopied, setStackCopied] = useState(false);

  // Import (unified)
  const [importCode, setImportCode] = useState("");
  const [importing, setImporting] = useState(false);
  const [stackPreview, setStackPreview] = useState<StackImportPreview | null>(null);
  const stackFileInputRef = useRef<HTMLInputElement>(null);

  const previewStackCode = useCallback(async (code: string, bridgeImport = false) => {
    setImporting(true);
    setStackPreview(null);
    try {
      const res = await fetch(`${CORE_URL}/api/stacks/import-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Import failed");
      const result = await res.json() as StackImportPreview;
      setStackPreview(result);
      toast.success(bridgeImport ? "Shared stack received — review it below" : "Stack decoded — review the apps below");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid code");
    } finally {
      setImporting(false);
    }
  }, []);

  useEffect(() => {
    let pendingCode = "";
    try {
      pendingCode = sessionStorage.getItem(PENDING_STACK_IMPORT_KEY)?.trim() ?? "";
      sessionStorage.removeItem(PENDING_STACK_IMPORT_KEY);
    } catch {
      return;
    }
    if (!pendingCode) return;
    setImportCode(pendingCode);
    void previewStackCode(pendingCode, true);
  }, [previewStackCode]);

  /* ── Settings export ── */

  async function generateSettingsCode() {
    setGenerating(true);
    try {
      const res = await fetch(`${CORE_URL}/api/settings/export-config`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Export failed");
      setGeneratedCode(data.code);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to generate setup code");
    } finally {
      setGenerating(false);
    }
  }

  async function copySettingsCode() {
    const ok = await copyToClipboard(generatedCode);
    if (!ok) { toast.error("Clipboard unavailable"); return; }
    setSettingsCopied(true);
    toast.success("Settings code copied");
    setTimeout(() => setSettingsCopied(false), 2000);
  }

  /* ── Stack export ── */

  async function exportStack() {
    setExporting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/stacks/export-running`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Export failed");
      const result = await res.json() as { stack: ImportedStack };

      const shareRes = await fetch(`${CORE_URL}/api/stacks/share-capsule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stack: result.stack }),
      });
      if (!shareRes.ok) throw new Error("Share failed");
      const shareResult = await shareRes.json() as StackCapsuleResponse;
      setStackCapsuleCode(shareResult.capsuleCode);
      setStackShareUrl(shareResult.linkCompatible ? buildPublicCapsuleUrl(shareResult.capsuleCode) ?? "" : "");
      setStackFileCode(shareResult.recipeFileCode);
      setStackFileName(shareResult.recipeFileName);
      setStackRecoveryCode(shareResult.recoveryFileCode);
      setStackRecoveryName(shareResult.recoveryFileName);
      setStackHasCustomApps(shareResult.hasCustomApps);
      toast.success("Portable stack code ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function copyStackCode() {
    const ok = await copyToClipboard(stackCapsuleCode);
    if (!ok) { toast.error("Clipboard unavailable"); return; }
    setStackCopied(true);
    toast.success("Stack code copied");
    setTimeout(() => setStackCopied(false), 2000);
  }

  function downloadStack() {
    if (!stackFileCode) return;
    downloadStackFile(stackFileCode, stackFileName);
    toast.success("Stack file downloaded");
  }

  function downloadRecovery() {
    if (!stackRecoveryCode) return;
    downloadStackFile(stackRecoveryCode, stackRecoveryName);
    toast.success("Recovery file downloaded");
  }

  async function loadStackFile(file: File | undefined) {
    if (!file) return;
    try {
      const code = codeFromStackFile(await file.text());
      if (!code) throw new Error("The stack file is empty");
      setImportCode(code);
      setStackPreview(null);
      toast.success("Stack file loaded — review and import it");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read stack file");
    } finally {
      if (stackFileInputRef.current) stackFileInputRef.current.value = "";
    }
  }

  /* ── Import ── */

  async function handleImport() {
    const code = importCode.trim();
    if (!code) return;
    setImporting(true);
    setStackPreview(null);

    // Try settings import first
    try {
      const res = await fetch(`${CORE_URL}/api/settings/import-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (res.ok && data.applied?.length > 0) {
        toast.success(`Applied ${data.applied.length} setting${data.applied.length !== 1 ? "s" : ""}: ${data.applied.join(", ")}`);
        setImportCode("");
        setImporting(false);
        return;
      }
    } catch { /* not a settings code, try stack */ }

    // Not a settings code — decode it as a stack recipe or recovery file.
    await previewStackCode(code);
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Export your settings or running app stack to share with other Talome instances, or import a code from someone else.
      </p>

      {/* ── Export ── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-sm font-medium text-foreground">Export</p>
        </SettingsRow>

        {/* Settings export */}
        <SettingsRow className="flex-wrap gap-y-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Settings</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Service URLs, tool preferences, and integrations — never API keys or passwords
            </p>
          </div>
          {generatedCode ? (
            <div className="flex items-center gap-2 w-full @lg:w-auto">
              <code className="text-xs font-mono text-muted-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 truncate flex-1 max-w-[200px]">
                {generatedCode}
              </code>
              <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => void copySettingsCode()}>
                {settingsCopied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground shrink-0" onClick={() => setGeneratedCode("")}>
                Dismiss
              </Button>
            </div>
          ) : (
            <Button
              size="sm" variant="secondary" className="h-7 text-xs px-4 shrink-0"
              disabled={generating} onClick={() => void generateSettingsCode()}
            >
              {generating ? "Generating..." : "Generate"}
            </Button>
          )}
        </SettingsRow>

        {/* Stack export */}
        <SettingsRow className="flex-wrap gap-y-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">App Stack</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Portable code works with Talome on any domain, LAN, or VPN address
            </p>
          </div>
          {stackCapsuleCode ? (
            <div className="flex items-center gap-2 w-full @lg:w-auto">
              <code className="text-xs font-mono text-muted-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 truncate flex-1 max-w-[200px]">
                {stackCapsuleCode}
              </code>
              <Button size="sm" variant="secondary" className="h-7 text-xs shrink-0" onClick={() => void copyStackCode()}>
                {stackCopied ? "Copied" : "Copy code"}
              </Button>
              {stackShareUrl && <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" asChild><a href={stackShareUrl} target="_blank" rel="noreferrer">Preview</a></Button>}
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs shrink-0" onClick={downloadStack}>
                <HugeiconsIcon icon={Download01Icon} size={12} />
                Recipe
              </Button>
              {stackHasCustomApps && <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={downloadRecovery}>Recovery</Button>}
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground shrink-0" onClick={() => { setStackCapsuleCode(""); setStackShareUrl(""); setStackFileCode(""); setStackRecoveryCode(""); }}>
                Dismiss
              </Button>
            </div>
          ) : (
            <Button
              size="sm" variant="secondary" className="h-7 text-xs px-4 shrink-0"
              disabled={exporting} onClick={() => void exportStack()}
            >
              {exporting ? "Exporting..." : "Generate"}
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>

      {/* ── Import ── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-sm font-medium text-foreground">Import</p>
        </SettingsRow>
        <SettingsRow className="flex-col items-stretch gap-3 py-4">
          <p className="text-sm text-muted-foreground">
            Paste a settings code, capsule link, or app stack code from another Talome instance.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Paste code..."
              value={importCode}
              onChange={(e) => setImportCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleImport(); }}
              className="h-8 text-sm font-mono flex-1"
            />
            <Button
              size="sm" className="h-8 text-xs px-4 shrink-0"
              disabled={importing || !importCode.trim()}
              onClick={() => void handleImport()}
            >
              {importing ? "Importing..." : "Import"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={stackFileInputRef}
              type="file"
              accept=".talome-stack,.talome-recovery,application/vnd.talome.stack,text/plain"
              className="hidden"
              onChange={(event) => void loadStackFile(event.target.files?.[0])}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => stackFileInputRef.current?.click()}
            >
              <HugeiconsIcon icon={FileAttachmentIcon} size={12} />
              Choose stack or recovery file
            </Button>
            <span className="text-xs text-muted-foreground">No access to the sender&apos;s server is needed.</span>
          </div>
        </SettingsRow>
      </SettingsGroup>

      {/* Stack preview (from imported code) */}
      {stackPreview && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
              <HugeiconsIcon icon={Layers01Icon} size={16} className="text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{stackPreview.stack.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{stackPreview.stack.description}</p>
            </div>
            <Badge variant="outline" className="text-xs shrink-0">
              {stackPreview.stack.apps.length} app{stackPreview.stack.apps.length !== 1 ? "s" : ""}
            </Badge>
          </div>

          <div className="space-y-1.5">
            {stackPreview.stack.apps.map((app) => (
              <div key={app.appId} className="flex items-center gap-2.5 py-2 px-3 rounded-lg bg-muted/30">
                <HugeiconsIcon
                  icon={app.installed ? CheckmarkCircle01Icon : app.available ? Package01Icon : AlertCircleIcon}
                  size={14}
                  className={app.installed ? "text-primary shrink-0" : app.available ? "text-muted-foreground shrink-0" : "text-status-warning shrink-0"}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{app.name}</p>
                  {app.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{app.description}</p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {app.installed
                    ? "Installed"
                    : app.available
                      ? app.requiredInputCount > 0
                        ? `${app.requiredInputCount} input${app.requiredInputCount !== 1 ? "s" : ""}`
                        : "Available"
                      : "Not in catalog"}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" className="h-8 gap-2" asChild>
              <Link href={`/dashboard/assistant?prompt=${encodeURIComponent(buildAssistantPrompt(stackPreview))}`}>
                <HugeiconsIcon icon={AiChat02Icon} size={14} />
                Continue with Assistant
              </Link>
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" onClick={() => setStackPreview(null)}>
              Dismiss
            </Button>
            <p className="w-full text-xs text-muted-foreground">
              {stackPreview.summary.missingCount > 0
                ? `${stackPreview.summary.missingCount} app${stackPreview.summary.missingCount !== 1 ? "s are" : " is"} not in this catalog; Assistant will propose alternatives.`
                : stackPreview.message}
            </p>
          </div>
        </div>
      )}

      <ConfigureWithAI prompt="Help me export my setup or import a configuration from another Talome instance" />
    </div>
  );
}
