"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { HugeiconsIcon, Add01Icon, CloudServerIcon, Delete02Icon, HardDriveIcon } from "@/components/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { backupErrorMessage, formatSchedule, parseCredentials, parseKeepCount, retentionSummary } from "../_lib/backup-status";
import type { BackupDestination, BackupSchedule } from "../_lib/types";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  });

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(backupErrorMessage(res.status, data, `Request failed (${res.status})`));
  return data;
}

type DestinationKind = "local" | "remote" | "managed";

const KIND_OPTIONS: Array<{ value: DestinationKind; label: string; placeholder: string; hint: string }> = [
  { value: "local", label: "Folder on this server", placeholder: "/mnt/usb/talome-backups", hint: "An external disk or NAS mount." },
  { value: "remote", label: "Existing rclone remote", placeholder: "b2:my-bucket/talome", hint: "A remote already set up with rclone config." },
  {
    value: "managed",
    label: "Cloud storage (credentials)",
    placeholder: "my-bucket/talome",
    hint: "Credentials are stored encrypted and handed to rclone privately — never on the command line.",
  },
];

// ── Destinations ──────────────────────────────────────────────────────────────

function AddDestinationForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DestinationKind>("local");
  const [target, setTarget] = useState("");
  const [remoteType, setRemoteType] = useState("s3");
  const [credentials, setCredentials] = useState("");
  const [saving, setSaving] = useState(false);
  const option = KIND_OPTIONS.find((o) => o.value === kind)!;

  async function add() {
    let parsed: Record<string, string> | undefined;
    if (kind === "managed") {
      const r = parseCredentials(credentials);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      parsed = r.credentials;
    }
    setSaving(true);
    try {
      await send(`${CORE_URL}/api/backups/destinations`, "POST", {
        name: name.trim() || option.label,
        type: kind === "local" ? "local" : "rclone",
        target: target.trim(),
        ...(kind === "managed" ? { remoteType: remoteType.trim().toLowerCase(), credentials: parsed } : {}),
      });
      toast.success("Destination added");
      setOpen(false);
      setName("");
      setTarget("");
      setCredentials("");
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add destination");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setOpen(true)}>
        <HugeiconsIcon icon={Add01Icon} size={16} />
        Add destination
      </Button>
    );
  }

  return (
    <div className="grid gap-4 rounded-lg border p-4">
      <div className="grid gap-2">
        <Label htmlFor="dest-kind">Where</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as DestinationKind)}>
          <SelectTrigger id="dest-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">{option.hint}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="dest-name">Name</Label>
        <Input id="dest-name" placeholder={option.label} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {kind === "managed" && (
        <div className="grid gap-2">
          <Label htmlFor="dest-provider">rclone backend</Label>
          <Input id="dest-provider" placeholder="s3, b2, sftp, drive…" value={remoteType} onChange={(e) => setRemoteType(e.target.value)} />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor="dest-target">{kind === "local" ? "Folder" : "Path"}</Label>
        <Input id="dest-target" placeholder={option.placeholder} value={target} onChange={(e) => setTarget(e.target.value)} />
      </div>
      {kind === "managed" && (
        <div className="grid gap-2">
          <Label htmlFor="dest-credentials">Credentials</Label>
          <Textarea
            id="dest-credentials"
            className="font-mono text-sm min-h-24"
            placeholder={"access_key_id=…\nsecret_access_key=…\nregion=eu-central-1"}
            value={credentials}
            onChange={(e) => setCredentials(e.target.value)}
          />
          <p className="text-sm text-muted-foreground">One rclone option per line.</p>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void add()} disabled={saving || !target.trim()}>
          {saving ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  );
}

function DestinationRow({ dest, onChanged }: { dest: BackupDestination; onChanged: () => void }) {
  const [busy, setBusy] = useState<"test" | "delete" | null>(null);
  const confirm = useConfirm();

  async function test() {
    setBusy("test");
    try {
      const r = (await send(`${CORE_URL}/api/backups/destinations/${dest.id}/test`, "POST")) as { ok?: boolean; error?: string };
      if (r.ok) toast.success(`${dest.name} is reachable`);
      else toast.error(`${dest.name} is not reachable`, { description: r.error });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    // The copies already there are not touched; schedules stop copying to it.
    await confirm({
      tier: "soft",
      title: `Remove ${dest.name}?`,
      consequence: "Schedules that copy backups there stop copying.",
      recovery: "Backups already copied there stay where they are. Add it again any time.",
      confirmLabel: `Remove ${dest.name}`,
      busyLabel: `Removing ${dest.name}…`,
      run: async () => {
        setBusy("delete");
        try {
          await send(`${CORE_URL}/api/backups/destinations/${dest.id}`, "DELETE");
          onChanged();
        } finally {
          setBusy(null);
        }
      },
      receipt: `Removed ${dest.name}`,
    });
  }

  return (
    <div className="flex items-center gap-3 min-w-0">
      <HugeiconsIcon icon={dest.type === "local" ? HardDriveIcon : CloudServerIcon} size={18} className="shrink-0 text-muted-foreground" />
      <div className="grid gap-0.5 min-w-0 flex-1">
        <span className="text-sm font-medium truncate">{dest.name}</span>
        <span className="text-sm text-muted-foreground truncate" title={dest.target}>
          {dest.target}
          {dest.type === "rclone" ? " · encrypted" : ""}
        </span>
      </div>
      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void test()}>
        {busy === "test" ? "Testing…" : "Test"}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${dest.name}`} disabled={busy !== null} onClick={() => void remove()}>
        <HugeiconsIcon icon={Delete02Icon} size={16} />
      </Button>
    </div>
  );
}

// ── Schedules ─────────────────────────────────────────────────────────────────

const KEEP_FIELDS = [
  { key: "keep_last", label: "Last" },
  { key: "keep_daily", label: "Daily" },
  { key: "keep_weekly", label: "Weekly" },
  { key: "keep_monthly", label: "Monthly" },
] as const;

type KeepKey = (typeof KEEP_FIELDS)[number]["key"];

const API_KEYS: Record<KeepKey, string> = {
  keep_last: "keepLast",
  keep_daily: "keepDaily",
  keep_weekly: "keepWeekly",
  keep_monthly: "keepMonthly",
};

function ScheduleRow({
  schedule,
  destinations,
  appName,
  onSaved,
}: {
  schedule: BackupSchedule;
  destinations: BackupDestination[];
  appName: string;
  onSaved: () => void;
}) {
  const [destinationId, setDestinationId] = useState(schedule.destination_id ?? "none");
  const [keep, setKeep] = useState<Record<KeepKey, string>>(() => ({
    keep_last: schedule.keep_last?.toString() ?? "",
    keep_daily: schedule.keep_daily?.toString() ?? "",
    keep_weekly: schedule.keep_weekly?.toString() ?? "",
    keep_monthly: schedule.keep_monthly?.toString() ?? "",
  }));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDestinationId(schedule.destination_id ?? "none");
  }, [schedule.destination_id]);

  const dirty =
    destinationId !== (schedule.destination_id ?? "none") ||
    KEEP_FIELDS.some((f) => keep[f.key] !== (schedule[f.key]?.toString() ?? ""));

  async function save() {
    const body: Record<string, unknown> = { destinationId: destinationId === "none" ? null : destinationId };
    for (const f of KEEP_FIELDS) {
      const n = parseKeepCount(keep[f.key]);
      if (n === undefined) {
        toast.error(`${f.label}: use a whole number between 0 and 1000, or leave it empty`);
        return;
      }
      body[API_KEYS[f.key]] = n;
    }
    setSaving(true);
    try {
      await send(`${CORE_URL}/api/backups/schedules/${schedule.id}`, "PATCH", body);
      toast.success("Schedule updated");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update schedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <span className="text-sm font-medium truncate">{appName}</span>
        {formatSchedule(schedule.cron) ? (
          <span className="text-sm text-muted-foreground shrink-0" title={schedule.cron}>{formatSchedule(schedule.cron)}</span>
        ) : (
          <span className="text-sm text-muted-foreground font-mono shrink-0">{schedule.cron}</span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {retentionSummary(schedule)}
        {schedule.enabled ? "" : " · paused"}
      </p>
      <div className="grid gap-2">
        <Label htmlFor={`dest-${schedule.id}`}>Copy to</Label>
        <Select value={destinationId} onValueChange={setDestinationId}>
          <SelectTrigger id={`dest-${schedule.id}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">This server only</SelectItem>
            {destinations.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {KEEP_FIELDS.map((f) => (
          <div key={f.key} className="grid gap-1">
            <Label htmlFor={`${f.key}-${schedule.id}`} className="text-sm text-muted-foreground">
              {f.label}
            </Label>
            <Input
              id={`${f.key}-${schedule.id}`}
              inputMode="numeric"
              placeholder="–"
              value={keep[f.key]}
              onChange={(e) => setKeep((k) => ({ ...k, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      {dirty && (
        <Button size="sm" className="justify-self-end" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      )}
    </div>
  );
}

// ── Sheet ─────────────────────────────────────────────────────────────────────

interface StorageSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appNames: Record<string, string>;
}

export function StorageSheet({ open, onOpenChange, appNames }: StorageSheetProps) {
  const destinations = useSWR<BackupDestination[]>(open ? `${CORE_URL}/api/backups/destinations` : null, fetcher);
  const schedules = useSWR<BackupSchedule[]>(open ? `${CORE_URL}/api/backups/schedules` : null, fetcher);
  const destList = destinations.data ?? [];
  const scheduleList = schedules.data ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0">
        <SheetHeader className="p-6">
          <SheetTitle>Storage &amp; retention</SheetTitle>
          <SheetDescription>Where backups are copied and how many are kept.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-6 px-6 pb-6 overflow-y-auto">
          <section className="grid gap-4">
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">Off-site copies</h3>
              <p className="text-sm text-muted-foreground">
                Copies sent through rclone are encrypted with this server&apos;s secret key before they leave it.
              </p>
            </div>
            {destinations.isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : destinations.error ? (
              <p className="text-sm text-status-critical">Couldn&apos;t load destinations.</p>
            ) : destList.length === 0 ? (
              <p className="text-sm text-muted-foreground">No destinations yet — backups stay on this server.</p>
            ) : (
              <div className="grid gap-3">
                {destList.map((d) => (
                  <DestinationRow key={d.id} dest={d} onChanged={() => void destinations.mutate()} />
                ))}
              </div>
            )}
            <AddDestinationForm onAdded={() => void destinations.mutate()} />
          </section>

          <Separator />

          <section className="grid gap-4">
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">Retention</h3>
              <p className="text-sm text-muted-foreground">
                Keep the newest backups plus one per day, week and month. The newest verified backup is always kept.
                Leave every field empty to keep backups for the schedule&apos;s number of days.
              </p>
            </div>
            {schedules.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : scheduleList.length === 0 ? (
              <p className="text-sm text-muted-foreground">No schedules yet.</p>
            ) : (
              <div className="grid gap-6">
                {scheduleList.map((s) => (
                  <ScheduleRow
                    key={s.id}
                    schedule={s}
                    destinations={destList}
                    appName={s.app_id ? (appNames[s.app_id] ?? s.app_id) : "All apps"}
                    onSaved={() => void schedules.mutate()}
                  />
                ))}
              </div>
            )}
            <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" asChild>
              <Link href="/dashboard/settings/backups">Manage schedules</Link>
            </Button>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
