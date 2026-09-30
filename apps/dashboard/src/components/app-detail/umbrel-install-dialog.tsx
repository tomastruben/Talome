"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  dependencyCandidates,
  formStateToOptions,
  installBlockReason,
  planToFormState,
  validateFormState,
  type UmbrelFormState,
  type UmbrelInstallOptions,
  type UmbrelInstallPlan,
} from "@/lib/umbrel-install";

/** Radix Select items can't use "" — stands for "keep the app's own default". */
const APP_DEFAULT = "__app_default__";

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export interface UmbrelInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  plan: UmbrelInstallPlan;
  /**
   * Install with the chosen options. Resolve with blocker messages to keep
   * the dialog open and show them (e.g. the server rejected a folder), or
   * null when the install started.
   */
  onConfirm: (options: UmbrelInstallOptions | undefined) => Promise<string[] | null>;
}

/**
 * Compact pre-install dialog for Umbrel apps: folder access (prefilled with
 * the plan's defaults), environment choices restricted to allowed options,
 * and dependency providers. Unsupported apps show the reason and cannot be
 * installed.
 */
export function UmbrelInstallDialog({ open, onOpenChange, appName, plan, onConfirm }: UmbrelInstallDialogProps) {
  const [form, setForm] = useState<UmbrelFormState>(() => planToFormState(plan));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverBlockers, setServerBlockers] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const blockReason = installBlockReason(plan);
  const dependencyChoices = plan.dependencies
    .map((dep) => ({ dep, candidates: dependencyCandidates(plan, dep) }))
    .filter((d) => d.candidates.length > 1);
  const warnings = plan.warnings.filter((w) => !w.startsWith("Several installed apps provide"));

  const update = <K extends keyof UmbrelFormState>(group: K, key: string, value: UmbrelFormState[K][string]) => {
    setForm((prev) => ({ ...prev, [group]: { ...prev[group], [key]: value } }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blockReason) return;
    const nextErrors = validateFormState(plan, form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setServerBlockers([]);
    try {
      const blockers = await onConfirm(formStateToOptions(plan, form));
      if (blockers && blockers.length > 0) setServerBlockers(blockers);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md max-h-[90svh] overflow-y-auto" showCloseButton>
        <form onSubmit={submit} className="grid gap-6">
          <DialogHeader>
            <DialogTitle>Install {appName}</DialogTitle>
            <DialogDescription>
              {blockReason ? "This app can't be installed right now." : "Review where the app keeps its files and how it's set up."}
            </DialogDescription>
          </DialogHeader>

          {blockReason && (
            <p className="text-sm text-status-critical break-words" role="alert">{blockReason}</p>
          )}

          {!blockReason && plan.folders.length > 0 && (
            <FieldGroup title="Folders">
              {plan.folders.map((slot) => {
                const errorKey = `folder:${slot.id}`;
                const inputId = `umbrel-folder-${slot.id}`;
                return (
                  <div key={slot.id} className="grid gap-1.5">
                    <Label htmlFor={inputId} className="text-sm">{slot.name}</Label>
                    {slot.note && <p className="text-xs text-muted-foreground">{slot.note}</p>}
                    <Input
                      id={inputId}
                      value={form.folders[slot.id] ?? ""}
                      onChange={(e) => update("folders", slot.id, e.target.value)}
                      placeholder={slot.defaultSource || "/path/to/folder"}
                      className="font-mono text-sm"
                      aria-invalid={!!errors[errorKey]}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {errors[errorKey] && <p className="text-xs text-destructive">{errors[errorKey]}</p>}
                    {slot.sharedDefault && (form.folders[slot.id] ?? "").trim() === slot.source && (
                      <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span>Shared folder — mounted read-only unless you allow writing</span>
                        <Switch
                          checked={form.folderWrite[slot.id] === true}
                          onCheckedChange={(checked) => update("folderWrite", slot.id, checked)}
                          aria-label={`Allow ${appName} to write to ${slot.name}`}
                        />
                      </label>
                    )}
                  </div>
                );
              })}
            </FieldGroup>
          )}

          {!blockReason && plan.environment.length > 0 && (
            <FieldGroup title="Settings">
              {plan.environment.map((env) => {
                const errorKey = `env:${env.name}`;
                const inputId = `umbrel-env-${env.name}`;
                const value = form.environment[env.name] ?? "";
                return (
                  <div key={env.name} className="grid gap-1.5">
                    <Label htmlFor={inputId} className="text-sm font-mono">{env.name}</Label>
                    {env.note && <p className="text-xs text-muted-foreground">{env.note}</p>}
                    {env.options ? (
                      <Select
                        value={value || APP_DEFAULT}
                        onValueChange={(next) => update("environment", env.name, next === APP_DEFAULT ? "" : next)}
                      >
                        <SelectTrigger id={inputId} className="w-full" aria-invalid={!!errors[errorKey]}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(!env.default || !env.options.includes(env.default)) && (
                            <SelectItem value={APP_DEFAULT}>App default</SelectItem>
                          )}
                          {env.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                              {option === env.default ? " (default)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={inputId}
                        value={value}
                        onChange={(e) => update("environment", env.name, e.target.value)}
                        placeholder={env.default ?? "App default"}
                        aria-invalid={!!errors[errorKey]}
                        autoComplete="off"
                      />
                    )}
                    {errors[errorKey] && <p className="text-xs text-destructive">{errors[errorKey]}</p>}
                  </div>
                );
              })}
            </FieldGroup>
          )}

          {!blockReason && dependencyChoices.length > 0 && (
            <FieldGroup title="Dependencies">
              {dependencyChoices.map(({ dep, candidates }) => {
                const inputId = `umbrel-dep-${dep.dependency}`;
                return (
                  <div key={dep.dependency} className="grid gap-1.5">
                    <Label htmlFor={inputId} className="text-sm">{dep.dependency}</Label>
                    <Select
                      value={form.dependencies[dep.dependency] || candidates[0]}
                      onValueChange={(next) => update("dependencies", dep.dependency, next)}
                    >
                      <SelectTrigger id={inputId} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {candidates.map((candidate) => (
                          <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </FieldGroup>
          )}

          {!blockReason && warnings.length > 0 && (
            <ul className="grid gap-1 text-xs text-muted-foreground list-disc pl-4">
              {warnings.map((warning) => (
                <li key={warning} className="break-words">{warning}</li>
              ))}
            </ul>
          )}

          {serverBlockers.length > 0 && (
            <ul className="grid gap-1 text-sm text-status-critical" role="alert">
              {serverBlockers.map((blocker) => (
                <li key={blocker} className="break-words">{blocker}</li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!!blockReason || submitting} className="gap-2">
              {submitting && <Spinner className="size-3.5" />}
              Install
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
