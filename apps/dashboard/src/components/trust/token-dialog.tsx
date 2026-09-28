"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import { HugeiconsIcon, Copy01Icon, CheckmarkCircle01Icon } from "@/components/icons";
import { copyToClipboard } from "@/components/settings/settings-primitives";
import { GrantEditor } from "@/components/trust/grant-editor";
import { createMcpToken, updateMcpToken, type CreatedToken } from "@/components/trust/api";
import {
  EXPIRY_OPTIONS,
  expiryPresetDays,
  expiryPresetToIso,
  formatExpiry,
  validateScopes,
  type ExpiryPreset,
  type GrantCatalog,
  type McpToken,
  type TokenScopes,
} from "@/components/trust/format";

export type TokenDialogMode = { kind: "create" } | { kind: "edit"; token: McpToken };

const READ_ONLY: TokenScopes = { maxTier: "read", domains: "all", apps: "all" };

type ExpiryChoice = ExpiryPreset | "keep";

function ExpiryPicker({
  value,
  onChange,
  keepLabel,
}: {
  value: ExpiryChoice;
  onChange: (v: ExpiryChoice) => void;
  keepLabel?: string;
}) {
  const options: { value: ExpiryChoice; label: string }[] = keepLabel
    ? [{ value: "keep", label: keepLabel }, ...EXPIRY_OPTIONS]
    : EXPIRY_OPTIONS;
  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Expires after</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Expiry">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs transition-colors duration-150 ease-out",
                active
                  ? "bg-foreground/10 text-foreground ring-1 ring-foreground/20"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TokenReveal({ created, onDone }: { created: CreatedToken; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Token created</DialogTitle>
        <DialogDescription>
          Copy it now and paste it into {created.name} as a Bearer token. It won&apos;t be shown again.
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-mono">
          {created.token}
        </code>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={async () => {
            const ok = await copyToClipboard(created.token);
            if (!ok) {
              toast.error("Clipboard unavailable");
              return;
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          <HugeiconsIcon icon={copied ? CheckmarkCircle01Icon : Copy01Icon} size={14} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{formatExpiry(created.expiresAt)}</p>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

function TokenForm({
  mode,
  catalog,
  onSaved,
  onCreated,
  onCancel,
}: {
  mode: TokenDialogMode;
  catalog: GrantCatalog | undefined;
  onSaved: () => void;
  onCreated: (created: CreatedToken) => void;
  onCancel: () => void;
}) {
  const editing = mode.kind === "edit" ? mode.token : null;
  const [name, setName] = useState("");
  // Legacy tokens start from read-only so "Save" never silently keeps full access.
  const [scopes, setScopes] = useState<TokenScopes>(
    editing && !editing.legacy ? editing.scopes : (catalog?.defaults ?? READ_ONLY),
  );
  const [expiry, setExpiry] = useState<ExpiryChoice>(editing ? "keep" : "30d");
  const [saving, setSaving] = useState(false);

  const invalid = validateScopes(scopes) ?? (!editing && !name.trim() ? "Name the client this token is for." : null);

  const submit = async () => {
    if (invalid || saving) return;
    setSaving(true);
    try {
      if (editing) {
        await updateMcpToken(editing.id, {
          scopes,
          ...(expiry === "keep" ? {} : { expiresAt: expiryPresetToIso(expiry) }),
        });
        toast.success(`Access updated for ${editing.name}`);
        onSaved();
      } else {
        const created = await createMcpToken({
          name: name.trim(),
          scopes,
          expiresInDays: expiryPresetDays(expiry === "keep" ? "30d" : expiry),
        });
        onSaved();
        onCreated(created);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save token");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{editing ? `Edit access · ${editing.name}` : "New agent token"}</DialogTitle>
        <DialogDescription>
          {editing?.legacy
            ? "This token predates access controls and has full access. Choose what it should be allowed to do."
            : "Give each AI client its own token with only the access it needs."}
        </DialogDescription>
      </DialogHeader>

      {!editing && (
        <div className="grid gap-2">
          <Label htmlFor="mcp-token-name" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Client
          </Label>
          <Input
            id="mcp-token-name"
            autoFocus
            maxLength={100}
            placeholder="e.g. Claude Desktop, Cursor"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}

      <GrantEditor catalog={catalog} value={scopes} onChange={setScopes} />

      <ExpiryPicker
        value={expiry}
        onChange={setExpiry}
        keepLabel={editing ? `Keep (${formatExpiry(editing.expiresAt).toLowerCase()})` : undefined}
      />

      <DialogFooter className="items-center">
        {invalid && <p className="text-xs text-muted-foreground sm:mr-auto">{invalid}</p>}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!!invalid || saving}>
          {saving ? "Saving…" : editing ? "Save access" : "Create token"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Create a token (then reveal the plaintext once) or edit an existing token's
 * grants and expiry.
 */
export function TokenDialog({
  open,
  onOpenChange,
  mode,
  catalog,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: TokenDialogMode;
  catalog: GrantCatalog | undefined;
  onSaved: () => void;
}) {
  const [created, setCreated] = useState<CreatedToken | null>(null);
  // Reset the one-time reveal when the dialog re-opens (not on close, so the
  // exit animation keeps showing what the user was looking at).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setCreated(null);
  }

  const close = () => onOpenChange(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {created ? (
          <TokenReveal created={created} onDone={close} />
        ) : (
          <TokenForm
            key={mode.kind === "edit" ? mode.token.id : "create"}
            mode={mode}
            catalog={catalog}
            onSaved={() => {
              onSaved();
              if (mode.kind === "edit") close();
            }}
            onCreated={setCreated}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
