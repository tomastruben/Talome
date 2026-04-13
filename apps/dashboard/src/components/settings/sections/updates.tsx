"use client";

import { useState } from "react";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  HugeiconsIcon,
  ArrowUp01Icon,
  Refresh01Icon,
} from "@/components/icons";
import { toast } from "sonner";
import { SettingsGroup, ToggleRow } from "@/components/settings/settings-primitives";
import { useAvailableUpdates, type AppUpdateInfo } from "@/hooks/use-available-updates";

interface UpdatePolicy {
  app_id: string;
  policy: "auto" | "manual" | "schedule";
  pre_backup: boolean | number;
}

const policyFetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

function UpdateRow({ app, onUpdated }: { app: AppUpdateInfo; onUpdated: () => void }) {
  const [updating, setUpdating] = useState(false);
  const { data: policy, mutate: mutatePolicy } = useSWR<UpdatePolicy>(
    `${CORE_URL}/api/updates/policies/${app.appId}`,
    policyFetcher,
  );

  const isAuto = policy?.policy === "auto";
  const preBackup = policy ? (typeof policy.pre_backup === "number" ? policy.pre_backup === 1 : policy.pre_backup !== false) : true;

  async function handleUpdate() {
    setUpdating(true);
    try {
      const res = await fetch(`${CORE_URL}/api/apps/${app.storeId}/${app.appId}/update`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Update failed");
      toast.success(`${app.name} updated to v${app.availableVersion}`);
      onUpdated();
    } catch (err) {
      toast.error(`Failed to update ${app.name}`, {
        description: err instanceof Error ? err.message : "Please try again",
      });
    } finally {
      setUpdating(false);
    }
  }

  async function toggleAutoUpdate(auto: boolean) {
    try {
      await fetch(`${CORE_URL}/api/updates/policies/${app.appId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: auto ? "auto" : "manual", preBackup }),
      });
      mutatePolicy();
    } catch {
      toast.error("Failed to update policy");
    }
  }

  async function togglePreBackup(enabled: boolean) {
    try {
      await fetch(`${CORE_URL}/api/updates/policies/${app.appId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: isAuto ? "auto" : "manual", preBackup: enabled }),
      });
      mutatePolicy();
    } catch {
      toast.error("Failed to update policy");
    }
  }

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <p className="text-sm font-medium">{app.name}</p>
            <span className="text-xs text-muted-foreground tabular-nums">{app.installedVersion}</span>
            {app.hasUpdate && (
              <>
                <span className="text-xs text-muted-foreground">→</span>
                <span className="text-xs font-medium tabular-nums">{app.availableVersion}</span>
              </>
            )}
          </div>
        </div>

        {app.hasUpdate && (
          <Button size="sm" onClick={handleUpdate} disabled={updating} className="h-7 text-xs px-3">
            {updating ? <Spinner size="sm" /> : <HugeiconsIcon icon={ArrowUp01Icon} size={14} />}
            <span className="ml-1">Update</span>
          </Button>
        )}
      </div>

      <div className="flex items-center gap-5 mt-2">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <Switch checked={isAuto} onCheckedChange={toggleAutoUpdate} className="scale-[0.65] origin-left" />
          <span className="text-[11px] text-muted-foreground leading-none">Auto-update</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <Switch checked={preBackup} onCheckedChange={togglePreBackup} className="scale-[0.65] origin-left" />
          <span className="text-[11px] text-muted-foreground leading-none">Backup first</span>
        </label>
      </div>
    </div>
  );
}

export function UpdatesSection() {
  const { updates, refresh, isLoading } = useAvailableUpdates();

  const { data: allApps, mutate: mutateAll } = useSWR<AppUpdateInfo[]>(
    `${CORE_URL}/api/updates`,
    policyFetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  const [updatingAll, setUpdatingAll] = useState(false);

  const apps = allApps ?? [];
  const appsWithUpdates = apps.filter((a) => a.hasUpdate);

  async function handleUpdateAll() {
    if (appsWithUpdates.length === 0) return;
    setUpdatingAll(true);
    let succeeded = 0;
    let failed = 0;
    for (const app of appsWithUpdates) {
      try {
        const res = await fetch(`${CORE_URL}/api/apps/${app.storeId}/${app.appId}/update`, {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) succeeded++;
        else failed++;
      } catch {
        failed++;
      }
    }
    setUpdatingAll(false);
    refresh();
    mutateAll();
    if (failed === 0) {
      toast.success(`Updated ${succeeded} app${succeeded !== 1 ? "s" : ""}`);
    } else {
      toast.warning(`Updated ${succeeded}, failed ${failed}`);
    }
  }

  function handleRefresh() {
    refresh();
    mutateAll();
  }

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {appsWithUpdates.length > 0
              ? `${appsWithUpdates.length} update${appsWithUpdates.length !== 1 ? "s" : ""} available`
              : "All apps are up to date"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={isLoading} className="size-8 p-0">
            <HugeiconsIcon icon={Refresh01Icon} size={14} className={isLoading ? "animate-spin" : ""} />
          </Button>
          {appsWithUpdates.length > 0 && (
            <Button size="sm" onClick={handleUpdateAll} disabled={updatingAll}>
              {updatingAll ? <Spinner size="sm" /> : <HugeiconsIcon icon={ArrowUp01Icon} size={14} />}
              <span className="ml-1">Update All</span>
            </Button>
          )}
        </div>
      </div>

      {/* App list */}
      {(isLoading && apps.length === 0) ? (
        <SettingsGroup>
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        </SettingsGroup>
      ) : apps.length === 0 ? (
        <SettingsGroup>
          <p className="text-sm text-muted-foreground py-8 text-center">No apps installed</p>
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          {[...apps]
            .sort((a, b) => (a.hasUpdate === b.hasUpdate ? 0 : a.hasUpdate ? -1 : 1))
            .map((app) => (
              <UpdateRow key={app.appId} app={app} onUpdated={handleRefresh} />
            ))}
        </SettingsGroup>
      )}
    </div>
  );
}
