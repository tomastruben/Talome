"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { CORE_URL } from "@/lib/constants";
import { copyText } from "@/components/ui/copy-button";
import { parseApprovalRequest, type ApprovalRequest } from "@/components/trust/format";

// ── Utility helpers ──────────────────────────────────────────────────────────

/**
 * "3m ago", "2h ago", "5d ago", then a date. A missing or unparseable
 * timestamp reads `never` ("Never" by default), never "Invalid Date".
 */
export function relativeTime(dateStr: string | null | undefined, never = "Never"): string {
  if (!dateStr) return never;
  const then = new Date(dateStr).getTime();
  if (!Number.isFinite(then)) return never;
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/** Copies text (Clipboard API, then the legacy fallback on plain-http origins). Prefer `<CopyButton>` for UI. */
export async function copyToClipboard(text: string): Promise<boolean> {
  return copyText(text);
}

/**
 * A settings write the server held for the owner's approval
 * (`approval_required`, e.g. re-pointing an endpoint a stored credential is
 * sent to): nothing is saved until an admin approves it in Approvals.
 */
export class SettingsApprovalRequiredError extends Error {
  readonly approval: ApprovalRequest;
  constructor(approval: ApprovalRequest) {
    super("This change needs an approval before it's saved. Review it in Approvals.");
    this.name = "SettingsApprovalRequiredError";
    this.approval = approval;
  }
}

/**
 * A settings write that throws with the server's message when it fails
 * (`!res.ok`, or a JSON `{ ok: false }` / `{ error }`), so no caller can
 * show "Saved" for a write that didn't happen. A write held for approval
 * throws `SettingsApprovalRequiredError`, whatever the HTTP status.
 */
export async function settingsRequest<T = unknown>(
  url: string,
  init: { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
  fallback = "Couldn't save. Check that the Talome server is reachable, then try again.",
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      credentials: "include",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new Error("Couldn't reach the Talome server. Check that it's running, then try again.");
  }
  const data = (await res.json().catch(() => null)) as unknown;
  const record = data && typeof data === "object" ? (data as { ok?: unknown; error?: unknown; approval?: unknown }) : null;
  const approval = parseApprovalRequest(data) ?? parseApprovalRequest(record?.approval);
  if (approval) throw new SettingsApprovalRequiredError(approval);
  if (!res.ok || record?.ok === false || (record && typeof record.error === "string" && record.error)) {
    const message = typeof record?.error === "string" && record.error ? record.error : fallback;
    throw new Error(message);
  }
  return data as T;
}

/** A GET fetcher for SWR that throws on failure, so a failed load never renders as empty data. */
export async function settingsFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
    throw new Error(typeof error === "string" && error ? error : `Couldn't load this (${res.status}).`);
  }
  return data as T;
}

export function maskKey(key: string): string {
  if (!key || key.length < 8) return key;
  return key.slice(0, 4) + "•".repeat(8) + key.slice(-4);
}

// ── Section chrome ───────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-medium text-muted-foreground px-1 mb-2">
      {children}
    </p>
  );
}

export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
      {children}
    </div>
  );
}

export function SettingsRow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`px-4 py-3.5 flex items-center gap-3 ${className}`}>
      {children}
    </div>
  );
}

// ── Row variants ─────────────────────────────────────────────────────────────

interface SecretRowProps {
  label: string;
  hint?: string;
  id: string;
  placeholder: string;
  storedValue: string;
  isEditing: boolean;
  onEdit: () => void;
  onChange: (val: string) => void;
}

export function SecretRow({ label, hint, id, placeholder, storedValue, isEditing, onEdit, onChange }: SecretRowProps) {
  return (
    <SettingsRow className="flex-wrap @lg:flex-nowrap gap-y-2">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="relative shrink-0 w-full @lg:w-72">
        <Input
          id={id}
          type="password"
          placeholder={storedValue && !isEditing ? maskKey(storedValue) : placeholder}
          disabled={storedValue !== "" && !isEditing}
          value={isEditing ? storedValue : ""}
          onChange={(e) => onChange(e.target.value)}
          className="text-sm h-8 pr-14"
          autoComplete="off"
        />
        {storedValue && !isEditing && (
          <button
            type="button"
            onClick={onEdit}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
          >
            Edit
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

export function TextRow({ label, hint, id, placeholder, value, onChange }: {
  label: string;
  hint?: string;
  id: string;
  placeholder: string;
  value: string;
  onChange: (val: string) => void;
}) {
  return (
    <SettingsRow className="flex-wrap @lg:flex-nowrap gap-y-2">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0 w-full @lg:w-72">
        <Input
          id={id}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="text-sm h-8"
        />
      </div>
    </SettingsRow>
  );
}

export function ToggleRow({ label, hint, checked, onCheckedChange }: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <SettingsRow>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </SettingsRow>
  );
}

export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground font-mono mt-1 break-all">{value}</p>
    </div>
  );
}

// ── Save footer ──────────────────────────────────────────────────────────────

export function SaveRow({ onSave, saving }: { onSave: () => void; saving: boolean }) {
  return (
    <SettingsRow className="bg-muted/30 justify-end py-3">
      <Button size="sm" onClick={onSave} busy={saving} busyLabel="Saving…" className="h-7 text-xs px-4">
        Save
      </Button>
    </SettingsRow>
  );
}

// ── Connection test ──────────────────────────────────────────────────────────

type TestStatus = "idle" | "testing" | "ok" | "error";

export function ConnectionTestRow({ service, url, apiKey }: { service: string; url: string; apiKey: string }) {
  const [status, setStatus] = useState<TestStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const runTest = async () => {
    setStatus("testing");
    setErrorMsg("");
    try {
      const res = await fetch(`${CORE_URL}/api/settings/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ service, url, apiKey }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setStatus("ok");
        setTimeout(() => setStatus("idle"), 4000);
      } else {
        setStatus("error");
        setErrorMsg(data?.error || `Couldn't connect to ${service}. Check the URL and API key, then test again.`);
      }
    } catch {
      setStatus("error");
      setErrorMsg("Couldn't reach the Talome server. Check that it's running, then test again.");
    }
  };

  return (
    <SettingsRow className="justify-end py-2.5 bg-muted/20">
      {status === "ok" && (
        <span className="text-xs text-status-healthy mr-2">Connected</span>
      )}
      {status === "error" && (
        <span role="alert" className="text-xs text-status-critical mr-2 truncate max-w-48" title={errorMsg}>{errorMsg}</span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={runTest}
        busy={status === "testing"}
        busyLabel="Testing connection…"
        disabled={!url}
        className="h-7 text-xs px-3"
      >
        Test connection
      </Button>
    </SettingsRow>
  );
}

// ── Service group: URL + key + test ──────────────────────────────────────────

export function MediaServiceGroup({
  name,
  service,
  urlId, urlValue, onUrlChange, urlPlaceholder,
  keyId, keyValue, isEditing, onEdit, onKeyChange, keyPlaceholder,
}: {
  name: string; service: string;
  urlId: string; urlValue: string; onUrlChange: (v: string) => void; urlPlaceholder: string;
  keyId: string; keyValue: string; isEditing: boolean; onEdit: () => void; onKeyChange: (v: string) => void; keyPlaceholder: string;
}) {
  return (
    <>
      <SettingsRow className="py-2.5">
        <p className="text-sm font-medium text-foreground">{name}</p>
      </SettingsRow>
      <TextRow label="URL" id={urlId} placeholder={urlPlaceholder} value={urlValue} onChange={onUrlChange} />
      <SecretRow
        label="API key" id={keyId} placeholder={keyPlaceholder}
        storedValue={keyValue} isEditing={isEditing} onEdit={onEdit} onChange={onKeyChange}
      />
      <ConnectionTestRow service={service} url={urlValue} apiKey={keyValue} />
    </>
  );
}
