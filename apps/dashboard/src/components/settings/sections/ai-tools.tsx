"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  HugeiconsIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete01Icon,
  Copy01Icon,
  Share04Icon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import {
  SettingsGroup,
  SettingsRow,
  copyToClipboard,
} from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

/* ── Types ─────────────────────────────────────────────── */

interface ToolMeta {
  name: string;
  tier: string;
  category: string;
  description?: string;
}

interface CustomToolFile {
  file: string;
  preview: string;
}

/* ── Built-in Tools Card ───────────────────────────────── */

function BuiltInToolsCard() {
  const [disabled, setDisabled] = useState<string[]>([]);
  const [allTools, setAllTools] = useState<ToolMeta[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings/tool-config`)
      .then((r) => r.json())
      .then((d: { disabled: string[] }) => setDisabled(d.disabled ?? []))
      .catch(() => {});

    fetch(`${CORE_URL}/api/settings/tool-tiers`)
      .then((r) => r.json())
      .then((d: { tools: ToolMeta[] }) => setAllTools(d.tools ?? []))
      .catch(() => {});
  }, []);

  function toggle(name: string) {
    setDisabled((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]
    );
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await fetch(`${CORE_URL}/api/settings/tool-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled }),
      });
      toast.success("Tool permissions saved");
      setDirty(false);
    } catch {
      toast.error("Failed to save");
    }
    setSaving(false);
  }

  function groupByCategory(tier: string) {
    const tools = allTools.filter((t) => t.tier === tier);
    const groups = new Map<string, ToolMeta[]>();
    for (const t of tools) {
      const list = groups.get(t.category) ?? [];
      list.push(t);
      groups.set(t.category, list);
    }
    return groups;
  }

  const destructiveTools = allTools.filter((t) => t.tier === "destructive");
  const modifyTools = allTools.filter((t) => t.tier === "modify");
  const destructiveOff = destructiveTools.filter((t) => disabled.includes(t.name)).length;
  const modifyOff = modifyTools.filter((t) => disabled.includes(t.name)).length;

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Built-in Tools</p>
      </SettingsRow>

      {/* Destructive tier */}
      {destructiveTools.length > 0 && (
        <SettingsRow className="flex-col items-stretch gap-3 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Destructive</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {destructiveTools.length - destructiveOff} of {destructiveTools.length} enabled
              </span>
            </div>
            <Switch
              checked={destructiveOff === 0}
              onCheckedChange={(on) => {
                const names = destructiveTools.map((t) => t.name);
                setDisabled((prev) =>
                  on ? prev.filter((n) => !names.includes(n)) : [...new Set([...prev, ...names])]
                );
                setDirty(true);
              }}
            />
          </div>
          <ToolGrid groups={groupByCategory("destructive")} disabled={disabled} onToggle={toggle} />
        </SettingsRow>
      )}

      {/* Modify tier */}
      {modifyTools.length > 0 && (
        <SettingsRow className="flex-col items-stretch gap-3 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Modify</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {modifyTools.length - modifyOff} of {modifyTools.length} enabled
              </span>
            </div>
            <Switch
              checked={modifyOff === 0}
              onCheckedChange={(on) => {
                const names = modifyTools.map((t) => t.name);
                setDisabled((prev) =>
                  on ? prev.filter((n) => !names.includes(n)) : [...new Set([...prev, ...names])]
                );
                setDirty(true);
              }}
            />
          </div>
          <ToolGrid groups={groupByCategory("modify")} disabled={disabled} onToggle={toggle} />
        </SettingsRow>
      )}

      {/* Footer */}
      <SettingsRow className="bg-muted/30 justify-between py-3">
        <p className="text-xs text-muted-foreground">Tap a tool to toggle it individually</p>
        <Button
          size="sm"
          className="h-7 text-xs px-4"
          onClick={() => void save()}
          disabled={saving || !dirty}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

function ToolGrid({
  groups,
  disabled,
  onToggle,
}: {
  groups: Map<string, ToolMeta[]>;
  disabled: string[];
  onToggle: (name: string) => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col gap-3">
        {[...groups.entries()].map(([category, tools]) => (
          <div key={category} className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{category}</p>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool) => {
                const isOff = disabled.includes(tool.name);
                const chip = (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => onToggle(tool.name)}
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-mono leading-none transition-all duration-150 select-none border",
                      isOff
                        ? "bg-transparent border-border/40 text-muted-foreground line-through decoration-dim-foreground"
                        : "bg-muted/40 border-border/50 text-foreground hover:bg-muted/70"
                    )}
                    aria-pressed={!isOff}
                  >
                    {tool.name}
                  </button>
                );

                if (!tool.description) return chip;

                return (
                  <Tooltip key={tool.name}>
                    <TooltipTrigger asChild>{chip}</TooltipTrigger>
                    <TooltipContent side="top" className="max-w-64">
                      {tool.description}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

/* ── Custom Tools Card ─────────────────────────────────── */

function CustomToolsCard() {
  const [toolFiles, setToolFiles] = useState<CustomToolFile[]>([]);
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const [installUrl, setInstallUrl] = useState("");
  const [installingUrl, setInstallingUrl] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [installFilename, setInstallFilename] = useState("");
  const [installCode, setInstallCode] = useState("");
  const [installing, setInstalling] = useState(false);

  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [publishingFile, setPublishingFile] = useState<string | null>(null);
  const [publishedUrls, setPublishedUrls] = useState<Record<string, string>>({});

  const fetchTools = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${CORE_URL}/api/tools/list`);
      if (r.ok) {
        const d = await r.json();
        setToolFiles(d.files ?? []);
        setActiveTools(d.activeTools ?? []);
      }
    } catch {
      /* silently skip */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchTools();
  }, [fetchTools]);

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
      toast.success(`${data.filename} installed`);
      setInstallUrl("");
      await fetchTools();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to install");
    } finally {
      setInstallingUrl(false);
    }
  }

  async function installManual() {
    if (!installFilename.trim() || !installCode.trim()) return;
    setInstalling(true);
    try {
      const filename =
        installFilename.trim().endsWith(".ts") || installFilename.trim().endsWith(".js")
          ? installFilename.trim()
          : `${installFilename.trim()}.ts`;
      const res = await fetch(`${CORE_URL}/api/tools/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, code: installCode }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Install failed");
      toast.success(`${filename} installed`);
      setInstallFilename("");
      setInstallCode("");
      setManualOpen(false);
      await fetchTools();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to install");
    } finally {
      setInstalling(false);
    }
  }

  async function shareTool(filename: string) {
    setPublishingFile(filename);
    try {
      const res = await fetch(`${CORE_URL}/api/tools/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Share failed");
      setPublishedUrls((prev) => ({ ...prev, [filename]: data.url }));
      const copied = await copyToClipboard(data.url);
      if (copied) toast.success("Share URL copied");
      else toast.success("Published — copy URL manually");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to share");
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
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeletingFile(null);
    }
  }

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Custom Tools</p>
        {toolFiles.length > 0 && (
          <Badge variant="secondary" className="ml-auto text-xs">{toolFiles.length}</Badge>
        )}
      </SettingsRow>

      {/* Install from URL */}
      <SettingsRow className="gap-2 py-3">
        <Input
          placeholder="Paste a GitHub Gist URL to install..."
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void installFromUrl();
          }}
          className="h-8 text-sm flex-1"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8 text-xs px-3 shrink-0"
          disabled={installingUrl || !installUrl.trim()}
          onClick={() => void installFromUrl()}
        >
          {installingUrl ? "Installing..." : "Install"}
        </Button>
      </SettingsRow>

      {/* Tool list */}
      {loading && toolFiles.length === 0 && (
        <SettingsRow>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </SettingsRow>
      )}

      {!loading && toolFiles.length === 0 && (
        <SettingsRow className="py-6">
          <div className="flex-1 text-center space-y-1">
            <p className="text-sm text-muted-foreground">No custom tools installed</p>
            <p className="text-xs text-muted-foreground">
              Install from a URL above, paste code below, or ask the assistant to create one.
            </p>
          </div>
        </SettingsRow>
      )}

      {toolFiles.map((f) => {
        const isActive = activeTools.some(
          (t) => t.replace("custom_", "") === f.file.replace(/\.ts$/, "")
        );
        const pubUrl = publishedUrls[f.file];

        return (
          <SettingsRow key={f.file} className="flex-col items-stretch gap-2 py-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-mono truncate">{f.file}</p>
                  {isActive ? (
                    <Badge
                      variant="outline"
                      className="text-xs px-1.5 py-0 text-status-healthy border-status-healthy/30 shrink-0"
                    >
                      active
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs px-1.5 py-0 shrink-0">
                      inactive
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                  {f.preview.split("\n")[0]}
                </p>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  onClick={() => void shareTool(f.file)}
                  disabled={publishingFile === f.file}
                  title="Share"
                >
                  <HugeiconsIcon icon={Share04Icon} size={14} />
                </button>
                <button
                  type="button"
                  className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-muted/50 transition-colors"
                  onClick={() => void deleteTool(f.file)}
                  disabled={deletingFile === f.file}
                  title="Delete"
                >
                  <HugeiconsIcon icon={Delete01Icon} size={14} />
                </button>
              </div>
            </div>
            {pubUrl && (
              <div className="flex items-center gap-2 bg-muted/30 rounded-lg px-2.5 py-1.5">
                <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                  {pubUrl}
                </span>
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={async () => {
                    const copied = await copyToClipboard(pubUrl);
                    if (copied) toast.success("URL copied");
                    else toast.error("Clipboard unavailable");
                  }}
                  title="Copy URL"
                >
                  <HugeiconsIcon icon={Copy01Icon} size={14} />
                </button>
              </div>
            )}
          </SettingsRow>
        );
      })}

      {/* Manual install */}
      <div className="border-t border-border/40">
        <button
          type="button"
          className="w-full px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setManualOpen((v) => !v)}
        >
          <HugeiconsIcon
            icon={manualOpen ? ArrowDown01Icon : ArrowRight01Icon}
            size={14}
            className="shrink-0"
          />
          Install manually
        </button>
        {manualOpen && (
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
              className="w-full min-h-[140px] rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                className="h-7 text-xs px-4"
                disabled={installing || !installFilename.trim() || !installCode.trim()}
                onClick={() => void installManual()}
              >
                {installing ? "Installing..." : "Install"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}

/* ── Main Section ──────────────────────────────────────── */

export function AiToolsSection() {
  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Control which tools the assistant can use. Disable destructive tools to prevent unintended changes, or add custom tools to extend its capabilities.
      </p>

      <BuiltInToolsCard />

      <CustomToolsCard />

      <p className="text-xs text-muted-foreground px-1">
        Custom tools are stored in ~/.talome/custom-tools/ and loaded at runtime.
      </p>

      <ConfigureWithAI prompt="I'd like to manage AI tool permissions" />
    </div>
  );
}
