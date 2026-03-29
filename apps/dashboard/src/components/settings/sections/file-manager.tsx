"use client";

import { useState, useEffect, useCallback } from "react";
import { HugeiconsIcon, ExternalDriveIcon } from "@/components/icons";
import { SettingsGroup, SettingsRow, SaveRow } from "@/components/settings/settings-primitives";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface DriveInfo {
  path: string;
  label: string;
  enabled: boolean;
}

export function FileManagerSection() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchDrives = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/files/drives`);
      const data = await res.json() as { drives: DriveInfo[] };
      setDrives(data.drives);
    } catch {
      // server may not be running
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchDrives(); }, [fetchDrives]);

  const toggle = (path: string) => {
    setDrives((prev) =>
      prev.map((d) => (d.path === path ? { ...d, enabled: !d.enabled } : d)),
    );
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const enabled = drives.filter((d) => d.enabled).map((d) => d.path);
      const res = await fetch(`${CORE_URL}/api/files/drives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (data.ok) {
        toast("Drive access updated");
        setDirty(false);
      } else {
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Control which external drives are accessible in the file manager.
        Only enabled drives will appear as browsable roots.
      </p>

      <SettingsGroup>
        {loading ? (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </SettingsRow>
        ) : drives.length === 0 ? (
          <SettingsRow>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">
                No external drives detected. Connect a drive and refresh.
              </p>
            </div>
          </SettingsRow>
        ) : (
          <>
            {drives.map((drive) => (
              <SettingsRow key={drive.path}>
                <div className={cn(
                  "size-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0",
                  drive.enabled ? "text-muted-foreground" : "text-dim-foreground",
                )}>
                  <HugeiconsIcon icon={ExternalDriveIcon} size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{drive.label}</p>
                  <p className="text-xs text-muted-foreground font-mono truncate">{drive.path}</p>
                </div>
                <Switch
                  checked={drive.enabled}
                  onCheckedChange={() => toggle(drive.path)}
                />
              </SettingsRow>
            ))}
            {dirty && <SaveRow onSave={() => void save()} saving={saving} />}
          </>
        )}
      </SettingsGroup>

      <p className="text-xs text-muted-foreground px-1">
        Talome&apos;s internal directories are always accessible. External drives must be
        explicitly enabled for security.
      </p>
    </div>
  );
}
