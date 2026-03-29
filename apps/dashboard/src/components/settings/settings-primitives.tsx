"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { CORE_URL } from "@/lib/constants";

// ── Utility helpers ──────────────────────────────────────────────────────────

export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback below.
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function maskKey(key: string): string {
  if (!key || key.length < 8) return key;
  return key.slice(0, 4) + "•".repeat(8) + key.slice(-4);
}

// ── Section chrome ───────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground px-1 mb-2">
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
    <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="relative shrink-0 w-full sm:w-72">
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
    <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0 w-full sm:w-72">
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
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
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
      <Button size="sm" onClick={onSave} disabled={saving} className="h-7 text-xs px-4">
        {saving ? "Saving..." : "Save"}
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
        body: JSON.stringify({ service, url, apiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus("ok");
        setTimeout(() => setStatus("idle"), 4000);
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Connection failed");
      }
    } catch {
      setStatus("error");
      setErrorMsg("Request failed");
    }
  };

  return (
    <SettingsRow className="justify-end py-2.5 bg-muted/20">
      {status === "ok" && (
        <span className="text-xs text-status-healthy mr-2">Connected</span>
      )}
      {status === "error" && (
        <span className="text-xs text-destructive mr-2 truncate max-w-[200px]">{errorMsg}</span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={runTest}
        disabled={status === "testing" || !url}
        className="h-7 text-xs px-3"
      >
        {status === "testing" ? "Testing..." : "Test Connection"}
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
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{name}</p>
      </SettingsRow>
      <TextRow label="URL" id={urlId} placeholder={urlPlaceholder} value={urlValue} onChange={onUrlChange} />
      <SecretRow
        label="API Key" id={keyId} placeholder={keyPlaceholder}
        storedValue={keyValue} isEditing={isEditing} onEdit={onEdit} onChange={onKeyChange}
      />
      <ConnectionTestRow service={service} url={urlValue} apiKey={keyValue} />
    </>
  );
}
