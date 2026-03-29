"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  HugeiconsIcon,
  Layers01Icon,
  Package01Icon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, copyToClipboard } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

/* ── Types (for imported stack preview) ────────────────── */

interface ImportedStackApp {
  appId: string;
  name: string;
  description?: string;
}

interface ImportedStack {
  id: string;
  name: string;
  description: string;
  apps: ImportedStackApp[];
}

/* ── Component ─────────────────────────────────────────── */

export function ExportImportSection() {
  // Settings export
  const [generating, setGenerating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState("");
  const [settingsCopied, setSettingsCopied] = useState(false);

  // Stack export
  const [exporting, setExporting] = useState(false);
  const [stackCode, setStackCode] = useState("");
  const [stackCopied, setStackCopied] = useState(false);

  // Import (unified)
  const [importCode, setImportCode] = useState("");
  const [importing, setImporting] = useState(false);
  const [stackPreview, setStackPreview] = useState<ImportedStack | null>(null);

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

      const shareRes = await fetch(`${CORE_URL}/api/stacks/share-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stack: result.stack }),
      });
      if (!shareRes.ok) throw new Error("Share failed");
      const shareResult = await shareRes.json() as { shareCode: string };
      setStackCode(shareResult.shareCode);
      toast.success("App stack exported");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function copyStackCode() {
    const ok = await copyToClipboard(stackCode);
    if (!ok) { toast.error("Clipboard unavailable"); return; }
    setStackCopied(true);
    toast.success("Stack code copied");
    setTimeout(() => setStackCopied(false), 2000);
  }

  /* ── Import ── */

  async function handleImport() {
    if (!importCode.trim()) return;
    setImporting(true);
    setStackPreview(null);

    // Try settings import first
    try {
      const res = await fetch(`${CORE_URL}/api/settings/import-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: importCode.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.applied?.length > 0) {
        toast.success(`Applied ${data.applied.length} setting${data.applied.length !== 1 ? "s" : ""}: ${data.applied.join(", ")}`);
        setImportCode("");
        setImporting(false);
        return;
      }
    } catch { /* not a settings code, try stack */ }

    // Try stack import
    try {
      const res = await fetch(`${CORE_URL}/api/stacks/import-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: importCode.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Import failed");
      const result = await res.json() as { valid: boolean; stack: ImportedStack };
      setStackPreview(result.stack);
      toast.success("Stack decoded — review the apps below");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Export your settings or running app stack to share with other Talome instances, or import a code from someone else.
      </p>

      {/* ── Export ── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Export</p>
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
            <div className="flex items-center gap-2 w-full sm:w-auto">
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
              Running apps as a shareable bundle — others can replicate your entire stack
            </p>
          </div>
          {stackCode ? (
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <code className="text-xs font-mono text-muted-foreground bg-muted/40 rounded-lg px-2.5 py-1.5 truncate flex-1 max-w-[200px]">
                {stackCode}
              </code>
              <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => void copyStackCode()}>
                {stackCopied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground shrink-0" onClick={() => setStackCode("")}>
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
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Import</p>
        </SettingsRow>
        <SettingsRow className="flex-col items-stretch gap-3 py-4">
          <p className="text-sm text-muted-foreground">
            Paste a settings code or app stack code from another Talome instance.
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
              <p className="text-sm font-medium">{stackPreview.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{stackPreview.description}</p>
            </div>
            <Badge variant="outline" className="text-xs shrink-0">
              {stackPreview.apps.length} app{stackPreview.apps.length !== 1 ? "s" : ""}
            </Badge>
          </div>

          <div className="space-y-1.5">
            {stackPreview.apps.map((app) => (
              <div key={app.appId} className="flex items-center gap-2.5 py-2 px-3 rounded-lg bg-muted/30">
                <HugeiconsIcon icon={Package01Icon} size={14} className="text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{app.name}</p>
                  {app.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{app.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => setStackPreview(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <ConfigureWithAI prompt="Help me export my setup or import a configuration from another Talome instance" />
    </div>
  );
}
