"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { METHOD_LABELS, METHOD_OPTIONS, parseExcludePatterns } from "../_lib/backup-status";
import type { AppBackupOverview, ConfiguredMethod } from "../_lib/types";

interface BackupSettingsSheetProps {
  app: AppBackupOverview | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function BackupSettingsSheet({ app, onOpenChange, onSaved }: BackupSettingsSheetProps) {
  const [method, setMethod] = useState<ConfiguredMethod>("auto");
  const [excludes, setExcludes] = useState("");
  const [healthUrl, setHealthUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!app) return;
    setMethod(app.config.method);
    setExcludes(app.config.excludePatterns.join("\n"));
    setHealthUrl(app.config.healthUrl ?? "");
  }, [app]);

  const option = METHOD_OPTIONS.find((o) => o.value === method);
  const dbList = app?.databases.filter((d) => d.engine !== "redis").map((d) => d.service) ?? [];

  async function save() {
    if (!app) return;
    setSaving(true);
    try {
      const res = await fetch(`${CORE_URL}/api/backups/apps/${encodeURIComponent(app.appId)}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method,
          excludePatterns: parseExcludePatterns(excludes),
          healthUrl: healthUrl.trim() ? healthUrl.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Check the values and try again");
      }
      toast.success(`Backup settings saved for ${app.name}`);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={app !== null} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0">
        <SheetHeader className="p-6">
          <SheetTitle>{app?.name} backups</SheetTitle>
          <SheetDescription>How Talome captures a consistent copy of this app.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-6 px-6 pb-6 overflow-y-auto">
          <div className="grid gap-2">
            <Label htmlFor="backup-method">Consistency</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as ConfiguredMethod)}>
              <SelectTrigger id="backup-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHOD_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{option?.description}</p>
            {method === "auto" && app?.effectiveMethod && (
              <p className="text-sm text-muted-foreground">
                Currently: {METHOD_LABELS[app.effectiveMethod]}
                {dbList.length > 0 ? ` (${dbList.join(", ")})` : ""}
              </p>
            )}
            {method === "dump" && dbList.length === 0 && (
              <p className="text-sm text-status-warning">No supported database found — backups will use a brief stop.</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="backup-excludes">Exclude</Label>
            <Textarea
              id="backup-excludes"
              className="font-mono text-sm min-h-28"
              placeholder={"cache/\n*.log\ndata/transcodes/*"}
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              One pattern per line. Excluded files are skipped when backing up and left untouched when restoring.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="backup-health">Health check URL</Label>
            <Input
              id="backup-health"
              placeholder="http://localhost:8989"
              value={healthUrl}
              onChange={(e) => setHealthUrl(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Optional. After a restore Talome waits for this address to respond before calling it done.
            </p>
          </div>
        </div>

        <SheetFooter className="p-6 border-t mt-auto">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
