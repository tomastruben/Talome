"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  HugeiconsIcon,
  ArchiveIcon,
  Delete01Icon,
  Tick01Icon,
  Cancel01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
} from "@/components/icons";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import { useInstalledApps } from "@/hooks/use-installed-apps";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/* ── Types ─────────────────────────────────────────── */

interface BackupRow {
  id: string;
  app_id: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  file_path: string | null;
  size_bytes: number | null;
  cloud_target: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  triggered_by: "manual" | "schedule";
  stage: string | null;
}

interface BackupSchedule {
  id: string;
  app_id: string | null;
  cron: string;
  cloud_target: string | null;
  retention_days: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

interface VolumeInfo {
  path: string;
  raw: string;
  target: string;
  type: "config" | "media";
  exists: boolean;
}

/* ── Helpers ───────────────────────────────────────── */

function formatSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

const STAGE_LABELS: Record<string, string> = {
  preparing: "Preparing",
  pausing: "Pausing services",
  archiving: "Archiving volumes",
  validating: "Validating",
  resuming: "Resuming services",
};

type Frequency = "6h" | "12h" | "daily" | "weekly" | "monthly";
type TimeSlot = "midnight" | "2am" | "4am" | "6am" | "noon";

const FREQUENCIES: { id: Frequency; label: string }[] = [
  { id: "6h", label: "Every 6h" },
  { id: "12h", label: "Every 12h" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

const TIME_SLOTS: { id: TimeSlot; label: string; hour: number }[] = [
  { id: "midnight", label: "12 AM", hour: 0 },
  { id: "2am", label: "2 AM", hour: 2 },
  { id: "4am", label: "4 AM", hour: 4 },
  { id: "6am", label: "6 AM", hour: 6 },
  { id: "noon", label: "12 PM", hour: 12 },
];

function buildCron(freq: Frequency, time: TimeSlot): string {
  const hour = TIME_SLOTS.find((t) => t.id === time)!.hour;
  switch (freq) {
    case "6h": return `0 */6 * * *`;
    case "12h": return `0 */12 * * *`;
    case "daily": return `0 ${hour} * * *`;
    case "weekly": return `0 ${hour} * * 0`;
    case "monthly": return `0 ${hour} 1 * *`;
  }
}

function needsTimeSlot(freq: Frequency): boolean {
  return freq === "daily" || freq === "weekly" || freq === "monthly";
}

function describeCron(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (hour.startsWith("*/")) return `Every ${hour.slice(2)} hours`;
  if (min.startsWith("*/")) return `Every ${min.slice(2)} minutes`;
  if (dom !== "*" && dow === "*") {
    const dayNum = parseInt(dom, 10);
    const suffix = dayNum === 1 ? "st" : dayNum === 2 ? "nd" : dayNum === 3 ? "rd" : "th";
    if (hour !== "*" && min !== "*") return `Monthly on the ${dayNum}${suffix} at ${hour}:${min.padStart(2, "0")}`;
    return `Monthly on the ${dayNum}${suffix}`;
  }
  if (dow !== "*" && dom === "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[parseInt(dow, 10)] ?? dow;
    if (hour !== "*" && min !== "*") return `Weekly on ${dayName} at ${hour}:${min.padStart(2, "0")}`;
    return `Weekly on ${dayName}`;
  }
  if (hour !== "*" && min !== "*" && dom === "*" && dow === "*") return `Daily at ${hour}:${min.padStart(2, "0")}`;

  return cron;
}

/* ── Schedule Builder ──────────────────────────────── */

function ScheduleBuilder({ onSubmit, disabled }: { onSubmit: (cron: string) => void; disabled: boolean }) {
  const [freq, setFreq] = useState<Frequency>("daily");
  const [time, setTime] = useState<TimeSlot>("2am");
  const [showCustom, setShowCustom] = useState(false);
  const [customCron, setCustomCron] = useState("0 2 * * *");

  const showTime = needsTimeSlot(freq);
  const cron = buildCron(freq, time);

  if (showCustom) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            className="h-8 text-sm font-mono flex-1"
            placeholder="0 2 * * *"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && customCron.trim() && onSubmit(customCron.trim())}
          />
          <Button size="sm" className="h-7 text-xs px-4" onClick={() => onSubmit(customCron.trim())} disabled={disabled || !customCron.trim()}>
            Add
          </Button>
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setShowCustom(false)}
        >
          Use presets
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Frequency</p>
        <div className="grid grid-cols-3 sm:grid-cols-5 rounded-lg border border-border p-0.5 bg-muted/30 gap-0.5">
          {FREQUENCIES.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFreq(f.id)}
              className={cn(
                "px-2 py-2.5 sm:py-1.5 text-xs rounded-md transition-all text-center",
                freq === f.id
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {showTime && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Time</p>
          <div className="grid grid-cols-3 sm:grid-cols-5 rounded-lg border border-border p-0.5 bg-muted/30 gap-0.5">
            {TIME_SLOTS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTime(t.id)}
                className={cn(
                  "px-2 py-2.5 sm:py-1.5 text-xs rounded-md transition-all text-center",
                  time === t.id
                    ? "bg-background text-foreground shadow-sm font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3 pt-1">
        <p className="text-sm text-muted-foreground">{describeCron(cron)}</p>
        <div className="flex items-center gap-3">
          <Button size="sm" className="h-9 sm:h-8 text-xs px-5 flex-1 sm:flex-none" onClick={() => onSubmit(cron)} disabled={disabled}>
            {disabled ? "Creating..." : "Create schedule"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowCustom(true)}
          >
            Custom
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Section ───────────────────────────────────────── */

export function BackupsSection() {
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string>("");
  const [backingUp, setBackingUp] = useState(false);
  const [selectedVolumes, setSelectedVolumes] = useState<Set<string>>(new Set());
  const { apps: installedApps } = useInstalledApps();

  // Poll faster while a backup is running
  const [fastPoll, setFastPoll] = useState(false);

  const { data: backups, mutate: mutateBackups } = useSWR<BackupRow[]>(
    `${CORE_URL}/api/backups`, fetcher, { refreshInterval: fastPoll ? 2_000 : 10_000 },
  );
  const { data: schedules, mutate: mutateSchedules } = useSWR<BackupSchedule[]>(
    `${CORE_URL}/api/backups/schedules`, fetcher,
  );

  // Fetch volumes when a specific app is selected
  const { data: appVolumes } = useSWR<VolumeInfo[]>(
    selectedApp && selectedApp !== "__all__" ? `${CORE_URL}/api/backups/volumes/${selectedApp}` : null,
    fetcher,
  );

  // Auto-select config volumes when app changes
  useEffect(() => {
    if (appVolumes) {
      setSelectedVolumes(new Set(
        appVolumes.filter((v) => v.exists && v.type === "config").map((v) => v.path),
      ));
    } else {
      setSelectedVolumes(new Set());
    }
  }, [appVolumes]);

  const backupList = backups ?? [];
  const scheduleList = schedules ?? [];
  const hasRunning = backupList.some((b) => b.status === "running");

  // Switch to fast polling when backup is active, stop when done
  useEffect(() => {
    if (backingUp || hasRunning) {
      setFastPoll(true);
    } else if (fastPoll) {
      const timer = setTimeout(() => setFastPoll(false), 3_000);
      return () => clearTimeout(timer);
    }
  }, [backingUp, hasRunning, fastPoll]);

  // Auto-clear backingUp when backup finishes
  useEffect(() => {
    if (backingUp && !hasRunning && backupList.length > 0) {
      setBackingUp(false);
    }
  }, [backingUp, hasRunning, backupList.length]);

  // Auto-expand history when backup records exist
  useEffect(() => {
    if (backupList.length > 0) setHistoryOpen(true);
  }, [backupList.length]);

  async function createSchedule(cron: string) {
    setCreating(true);
    try {
      const res = await fetch(`${CORE_URL}/api/backups/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron }),
      });
      if (!res.ok) throw new Error("Failed to create schedule");
      toast.success("Backup schedule created");
      mutateSchedules();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setCreating(false);
    }
  }

  async function triggerSingleBackup(appId: string, volumes?: string[]) {
    const res = await fetch(`${CORE_URL}/api/backups/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, volumes }),
    });
    if (!res.ok) {
      const result = await res.json();
      throw new Error(result.error ?? "Failed to start backup");
    }
  }

  async function triggerBackup() {
    if (!selectedApp) return;
    setBackingUp(true);
    try {
      if (selectedApp === "__all__") {
        for (const app of installedApps) {
          await triggerSingleBackup(app.id);
        }
        toast.success("Backups started for all apps");
      } else {
        const vols = selectedVolumes.size > 0 ? [...selectedVolumes] : undefined;
        await triggerSingleBackup(selectedApp, vols);
        toast.success("Backup started");
      }
      mutateBackups();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backup failed");
      setBackingUp(false);
    }
  }

  const handleCancelBackup = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${CORE_URL}/api/backups/${id}/cancel`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to cancel");
      }
      toast.success("Backup cancelled");
      mutateBackups();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel backup");
    }
  }, [mutateBackups]);

  async function handleDeleteSchedule(id: string) {
    try {
      await fetch(`${CORE_URL}/api/backups/schedules/${id}`, { method: "DELETE" });
      toast.success("Schedule removed");
      mutateSchedules();
    } catch {
      toast.error("Failed to remove schedule");
    }
  }

  async function handleDeleteBackup(id: string) {
    try {
      const res = await fetch(`${CORE_URL}/api/backups/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to delete backup");
      }
      toast.success("Backup deleted");
      mutateBackups();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete backup");
    }
  }

  const isActive = backingUp || hasRunning;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Schedule automatic backups for your apps and data. Backups can also be triggered manually through the assistant.
      </p>

      {/* Active schedules */}
      {scheduleList.length > 0 && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active Schedules</p>
            <Badge variant="secondary" className="ml-auto text-xs">{scheduleList.length}</Badge>
          </SettingsRow>
          {scheduleList.map((s) => (
            <SettingsRow key={s.id}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{describeCron(s.cron)}</p>
                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                  {s.app_id ? s.app_id : "All apps"}
                  {" · "}{s.retention_days}d retention
                  {s.cloud_target && ` · ${s.cloud_target}`}
                  {" · "}Last run {relativeTime(s.last_run_at ?? "")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => handleDeleteSchedule(s.id)}
              >
                <HugeiconsIcon icon={Delete01Icon} size={16} />
              </Button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      {/* New schedule */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">New Schedule</p>
        </SettingsRow>
        <SettingsRow className="flex-col items-stretch py-4">
          <ScheduleBuilder onSubmit={createSchedule} disabled={creating} />
        </SettingsRow>
      </SettingsGroup>

      {/* Backup now */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Backup Now</p>
        </SettingsRow>
        <SettingsRow className="flex-col items-stretch gap-3">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full">
            <Select value={selectedApp} onValueChange={setSelectedApp}>
              <SelectTrigger size="sm" className="flex-1 w-full">
                <SelectValue placeholder="Select an app" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All apps</SelectItem>
                {installedApps.map((app) => (
                  <SelectItem key={app.id} value={app.id}>
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-9 sm:h-8 text-xs px-5 shrink-0"
              onClick={triggerBackup}
              disabled={!selectedApp || isActive || (selectedApp !== "__all__" && selectedVolumes.size === 0)}
            >
              {isActive ? (
                <Shimmer as="span" duration={1.5}>Backing up...</Shimmer>
              ) : (
                "Backup now"
              )}
            </Button>
          </div>

          {/* Volume checkboxes — shown when a specific app is selected */}
          {selectedApp && selectedApp !== "__all__" && appVolumes && appVolumes.filter((v) => v.exists).length > 0 && (
            <div className="space-y-1.5">
              {appVolumes.filter((v) => v.exists).map((v) => (
                <label key={v.path} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={selectedVolumes.has(v.path)}
                    onChange={() => {
                      const next = new Set(selectedVolumes);
                      if (next.has(v.path)) next.delete(v.path);
                      else next.add(v.path);
                      setSelectedVolumes(next);
                    }}
                    className="size-3.5 rounded border-border accent-primary"
                  />
                  <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors truncate">
                    {v.raw}
                    <span className="ml-1.5 opacity-50">{v.target}</span>
                  </span>
                  <Badge variant="outline" className={cn(
                    "text-xs ml-auto shrink-0",
                    v.type === "media" ? "text-status-warning/70" : "opacity-50",
                  )}>
                    {v.type}
                  </Badge>
                </label>
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>

      {/* Backup history */}
      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 py-2 w-full">
            <HugeiconsIcon icon={historyOpen ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
            <span className="font-medium uppercase tracking-wider">History</span>
            <span className="font-normal tabular-nums">{backupList.length}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3">
            {backupList.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 flex flex-col items-center gap-2 text-center">
                <HugeiconsIcon icon={ArchiveIcon} size={24} className="text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No backups yet</p>
                <p className="text-xs text-muted-foreground">
                  Backups will appear here when scheduled or triggered manually via the assistant.
                </p>
              </div>
            ) : (
              <SettingsGroup>
                {backupList.map((b) => (
                  <SettingsRow key={b.id}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">
                          {b.app_id ?? "Full backup"}
                        </p>
                        <Badge variant="outline" className="text-xs">
                          {b.status === "completed" && <HugeiconsIcon icon={Tick01Icon} size={10} className="mr-0.5" />}
                          {b.status === "failed" && <HugeiconsIcon icon={Cancel01Icon} size={10} className="mr-0.5" />}
                          {b.status === "cancelled" && <HugeiconsIcon icon={Cancel01Icon} size={10} className="mr-0.5" />}
                          {b.status === "running" ? (
                            <Shimmer as="span" duration={1.5}>{b.stage ? STAGE_LABELS[b.stage] ?? b.stage : "running"}</Shimmer>
                          ) : (
                            b.status
                          )}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {relativeTime(b.started_at)}
                        {b.size_bytes ? ` · ${formatSize(b.size_bytes)}` : ""}
                        {b.cloud_target ? ` · ${b.cloud_target}` : ""}
                        {b.triggered_by === "schedule" ? " · scheduled" : " · manual"}
                      </p>
                      {b.error && (
                        <p className="text-xs text-destructive mt-0.5 break-words">{b.error}</p>
                      )}
                    </div>
                    {b.status === "running" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => handleCancelBackup(b.id)}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={16} />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => handleDeleteBackup(b.id)}
                      >
                        <HugeiconsIcon icon={Delete01Icon} size={16} />
                      </Button>
                    )}
                  </SettingsRow>
                ))}
              </SettingsGroup>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConfigureWithAI prompt="I'd like to configure backup schedules for my apps" />
    </div>
  );
}
