"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SaveRow, SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";
import { CORE_URL } from "@/lib/constants";
import {
  RETENTION_FIELDS,
  describeRetentionDefault,
  retentionChanges,
  retentionDraftFromSettings,
  validateRetentionDraft,
  type RetentionDraft,
} from "@/lib/retention";

const SETTINGS_URL = `${CORE_URL}/api/settings`;

async function settingsFetcher(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
  return res.json();
}

/**
 * How long Talome keeps logs and events before the daily cleanup removes
 * them (core db/retention.ts). Empty fields use the default.
 */
export function DataRetentionSection() {
  const { data, error, isLoading, mutate } = useSWR(SETTINGS_URL, settingsFetcher, { revalidateOnFocus: false });
  const initial = useMemo(() => retentionDraftFromSettings(data), [data]);
  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const values = draft ?? initial;
  const errors = validateRetentionDraft(values);
  const changes = retentionChanges(initial, values);
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    if (Object.keys(errors).length > 0) {
      toast.error("Fix the highlighted values first");
      return;
    }
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await fetch(SETTINGS_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : `Save failed (${res.status})`);
      }
      await mutate();
      setDraft(null);
      toast.success("Retention settings saved", { description: "They apply at the next daily cleanup." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save retention settings");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-muted-foreground">Couldn&apos;t load settings. Check that the Talome server is reachable.</p>;
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Talome removes old log and event rows once a day so the database stays small. Leave a field empty to use the default.
      </p>

      <SettingsGroup>
        {RETENTION_FIELDS.map((field) => {
          const id = `retention-${field.key}`;
          const fieldError = errors[field.key];
          return (
            <SettingsRow key={field.key} className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <Label htmlFor={id} className="text-sm font-medium cursor-pointer">{field.label}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
                {fieldError && <p className="text-xs text-destructive mt-1">{fieldError}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Input
                  id={id}
                  inputMode="numeric"
                  value={values[field.key] ?? ""}
                  placeholder={String(field.defaultValue)}
                  onChange={(e) => setDraft({ ...values, [field.key]: e.target.value })}
                  aria-invalid={!!fieldError}
                  aria-describedby={`${id}-unit`}
                  className="h-8 w-24 text-sm tabular-nums text-right"
                />
                <span id={`${id}-unit`} className="text-xs text-muted-foreground w-24">
                  {field.unit}
                  <span className="block text-dim-foreground">Default {describeRetentionDefault(field)}</span>
                </span>
              </div>
            </SettingsRow>
          );
        })}
        {dirty && <SaveRow onSave={save} saving={saving} />}
      </SettingsGroup>
    </div>
  );
}
