"use client";

import { useState, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, copyToClipboard } from "@/components/settings/settings-primitives";

interface CustomToolFile {
  file: string;
  preview: string;
}

export function CommunityToolsSection() {
  const [toolFiles, setToolFiles] = useState<CustomToolFile[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [publishingFile, setPublishingFile] = useState<string | null>(null);
  const [publishedUrls, setPublishedUrls] = useState<Record<string, string>>({});
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  const [installOpen, setInstallOpen] = useState(false);
  const [installFilename, setInstallFilename] = useState("");
  const [installCode, setInstallCode] = useState("");
  const [installing, setInstalling] = useState(false);

  const [installUrl, setInstallUrl] = useState("");
  const [installingUrl, setInstallingUrl] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${CORE_URL}/api/tools/list`);
      if (r.ok) {
        const d = await r.json();
        setToolFiles(d.files ?? []);
        setActiveTools(d.activeTools ?? []);
      }
    } catch { /* silently skip */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchTools(); }, [fetchTools]);

  async function copyCode(filename: string) {
    try {
      const res = await fetch(`${CORE_URL}/api/tools/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      if (!res.ok) throw new Error("Share failed");
      const { code } = await res.json();
      const copied = await copyToClipboard(code);
      if (!copied) throw new Error("Clipboard unavailable on this device");
      setCopiedFile(filename);
      toast.success("Tool code copied to clipboard");
      setTimeout(() => setCopiedFile(null), 2000);
    } catch {
      toast.error("Failed to copy tool");
    }
  }

  async function publishTool(filename: string) {
    setPublishingFile(filename);
    try {
      const res = await fetch(`${CORE_URL}/api/tools/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Publish failed");
      setPublishedUrls((prev) => ({ ...prev, [filename]: data.url }));
      const copied = await copyToClipboard(data.url);
      if (!copied) throw new Error("Clipboard unavailable on this device");
      toast.success("Shareable URL copied to clipboard");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to publish");
    } finally {
      setPublishingFile(null);
    }
  }

  async function deleteTool(filename: string) {
    setDeletingFile(filename);
    try {
      const res = await fetch(`${CORE_URL}/api/tools/${encodeURIComponent(filename)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Delete failed");
      toast.success(`${filename} removed`);
      await fetchTools();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete tool");
    } finally {
      setDeletingFile(null);
    }
  }

  async function installTool() {
    if (!installFilename.trim() || !installCode.trim()) return;
    setInstalling(true);
    try {
      const filename = installFilename.trim().endsWith(".ts") || installFilename.trim().endsWith(".js")
        ? installFilename.trim()
        : `${installFilename.trim()}.ts`;
      const res = await fetch(`${CORE_URL}/api/tools/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, code: installCode }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Install failed");
      toast.success(`${filename} installed and activated`);
      setInstallFilename("");
      setInstallCode("");
      setInstallOpen(false);
      await fetchTools();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to install tool");
    } finally {
      setInstalling(false);
    }
  }

  async function installFromUrl() {
    if (!installUrl.trim()) return;
    setInstallingUrl(true);
    try {
      const res = await fetch(`${CORE_URL}/api/tools/install-from-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: installUrl.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Install failed");
      toast.success(`${data.filename} installed and activated`);
      setInstallUrl("");
      await fetchTools();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to install tool from URL");
    } finally {
      setInstallingUrl(false);
    }
  }

  return (
    <div className="grid gap-2">
      {/* Install from URL */}
      <div className="flex gap-2">
        <Input
          placeholder="Paste GitHub Gist URL to install a tool…"
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void installFromUrl(); }}
          className="h-8 text-sm flex-1"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-xs px-3 shrink-0"
          disabled={installingUrl || !installUrl.trim()}
          onClick={() => void installFromUrl()}
        >
          {installingUrl ? "Installing…" : "Install"}
        </Button>
      </div>

      <SettingsGroup>
        {loading && toolFiles.length === 0 && (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </SettingsRow>
        )}

        {!loading && toolFiles.length === 0 && (
          <SettingsRow>
            <div className="flex-1 space-y-1">
              <p className="text-sm text-muted-foreground">No custom tools yet.</p>
              <p className="text-xs text-muted-foreground">
                Paste a Gist URL above, install one below, or ask the AI to create a tool.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs px-3 shrink-0"
              onClick={() => {
                document.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
                );
              }}
            >
              Ask AI
            </Button>
          </SettingsRow>
        )}

        {toolFiles.map((f, i) => {
          const isActive = activeTools.some((t) => t.replace("custom_", "") === f.file.replace(/\.ts$/, ""));
          const pubUrl = publishedUrls[f.file];
          return (
            <div key={f.file}>
              {i > 0 && <div className="h-px bg-border/60 mx-4" />}
              <SettingsRow className="flex-col items-stretch gap-2 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-medium font-mono truncate flex-1">{f.file}</p>
                  {isActive ? (
                    <Badge variant="outline" className="text-xs px-1.5 py-0 text-emerald-600 border-emerald-200 dark:border-emerald-800 shrink-0">active</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs px-1.5 py-0 shrink-0">inactive</Badge>
                  )}
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => void copyCode(f.file)}
                    >
                      {copiedFile === f.file ? "Copied!" : "Copy"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2 text-muted-foreground hover:text-foreground"
                      disabled={publishingFile === f.file}
                      onClick={() => void publishTool(f.file)}
                    >
                      {publishingFile === f.file ? "…" : "Share"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2 text-destructive hover:text-destructive"
                      disabled={deletingFile === f.file}
                      onClick={() => void deleteTool(f.file)}
                    >
                      {deletingFile === f.file ? "…" : "Delete"}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {f.preview.split("\n")[0]}
                </p>
                {pubUrl && (
                  <div className="flex items-center gap-2 bg-muted/40 rounded-lg px-2.5 py-1.5">
                    <span className="text-xs font-mono text-muted-foreground truncate flex-1">{pubUrl}</span>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                      onClick={async () => {
                        const copied = await copyToClipboard(pubUrl);
                        if (!copied) {
                          toast.error("Clipboard unavailable on this device");
                          return;
                        }
                        toast.success("URL copied");
                      }}
                    >
                      Copy
                    </button>
                    <a
                      href={pubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    >
                      Open ↗
                    </a>
                  </div>
                )}
              </SettingsRow>
            </div>
          );
        })}

        {/* Install panel */}
        <div className="border-t border-border/60">
          <button
            type="button"
            className="w-full px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setInstallOpen((v) => !v)}
          >
            <HugeiconsIcon icon={installOpen ? ArrowDown01Icon : ArrowRight01Icon} size={14} className="shrink-0" />
            Install a tool manually
          </button>
          {installOpen && (
            <div className="px-4 pb-4 space-y-2">
              <Input
                placeholder="filename.ts"
                value={installFilename}
                onChange={(e) => setInstallFilename(e.target.value)}
                className="h-8 text-sm font-mono"
              />
              <textarea
                placeholder={`import { tool } from 'ai';\nimport { z } from 'zod';\n\nexport const myTool = tool({\n  description: '...',\n  parameters: z.object({ ... }),\n  execute: async (args) => { ... },\n});`}
                value={installCode}
                onChange={(e) => setInstallCode(e.target.value)}
                className="w-full min-h-[160px] rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-7 text-xs px-4"
                  disabled={installing || !installFilename.trim() || !installCode.trim()}
                  onClick={() => void installTool()}
                >
                  {installing ? "Installing…" : "Install"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>
      <p className="text-xs text-muted-foreground px-1">
        Tools are stored in ~/.talome/custom-tools/ and loaded at runtime.
      </p>
    </div>
  );
}
