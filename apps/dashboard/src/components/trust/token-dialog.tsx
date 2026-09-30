"use client";

import { useRef, useState } from "react";
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
import { CopyButton } from "@/components/ui/copy-button";
import { CheckboxField } from "@/components/ui/checkbox";
import { GrantEditor } from "@/components/trust/grant-editor";
import { createMcpToken, maskSecret, MCP_CLIENT_FILES, mcpClientConfig, mcpServerUrl, updateMcpToken, type CreatedToken } from "@/components/trust/api";
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
      <p className="text-sm font-medium text-foreground">Expires after</p>
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

/**
 * The one time the access token is shown. It is masked on screen (Show
 * reveals it), and the dialog can't be closed until it was copied or the
 * person confirms they saved it another way: losing it to Esc or a stray
 * click would mean creating new access.
 */
function TokenReveal({
  created,
  serverUrl,
  saved,
  onSaved,
  onDone,
}: {
  created: CreatedToken;
  serverUrl: string;
  saved: boolean;
  onSaved: () => void;
  onDone: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [manual, setManual] = useState(false);
  const [nudge, setNudge] = useState(false);
  const tokenRef = useRef<HTMLElement>(null);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect {created.name}</DialogTitle>
        <DialogDescription>
          Copy the access token or a ready-made config for {created.name}. Talome shows the token only once.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <p className="text-sm font-medium text-foreground">Access token</p>
        <div className="flex items-start gap-2">
          <code
            ref={tokenRef}
            aria-label={revealed ? "Access token" : "Access token, hidden"}
            className="flex-1 min-w-0 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-mono select-all"
          >
            {revealed ? created.token : maskSecret(created.token)}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0"
            aria-pressed={revealed}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
          <CopyButton
            value={created.token}
            label="Copy access token"
            size="sm"
            variant="secondary"
            className="shrink-0"
            onCopied={onSaved}
            // A failed copy reveals and selects the token so it can be copied by hand.
            selectOnFailRef={tokenRef}
            onCopyFailed={() => setRevealed(true)}
          />
        </div>
        <p className="text-xs text-muted-foreground">{formatExpiry(created.expiresAt)}</p>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium text-foreground">Or copy a config with the token filled in</p>
        <div className="flex flex-wrap gap-2">
          {(["claude-code", "claude-desktop", "cursor"] as const).map((client) => (
            <CopyButton
              key={client}
              value={() => mcpClientConfig(client, serverUrl, created.token)}
              label={`Copy ${MCP_CLIENT_FILES[client].name} config`}
              text={MCP_CLIENT_FILES[client].name}
              size="sm"
              variant="outline"
              onCopied={onSaved}
            />
          ))}
        </div>
      </div>
      {!saved && revealed ? (
        <CheckboxField
          label="I saved the token somewhere else"
          checked={manual}
          onCheckedChange={(checked) => {
            setManual(checked === true);
            if (checked === true) onSaved();
          }}
        />
      ) : null}
      <DialogFooter className="items-center">
        {nudge && !saved ? (
          <p role="alert" className="text-xs text-status-critical sm:mr-auto">
            Copy the token first. Talome can&apos;t show it again.
          </p>
        ) : null}
        <Button
          aria-disabled={!saved || undefined}
          onClick={() => {
            if (!saved) {
              setNudge(true);
              return;
            }
            onDone();
          }}
        >
          Done
        </Button>
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

  const invalid = validateScopes(scopes) ?? (!editing && !name.trim() ? "Name the agent this access is for." : null);

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
      toast.error(err instanceof Error ? err.message : "Couldn't save the access. Try again.");
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
        <DialogTitle>{editing ? `Edit ${editing.name}'s access` : "Connect an agent"}</DialogTitle>
        <DialogDescription>
          {editing?.legacy
            ? "This access predates access controls and can do anything. Choose what it should be allowed to do."
            : "Give each agent its own access with only what it needs."}
        </DialogDescription>
      </DialogHeader>

      {!editing && (
        <div className="grid gap-2">
          <Label htmlFor="mcp-token-name" className="text-sm font-medium text-foreground">
            Agent name
          </Label>
          <Input
            id="mcp-token-name"
            autoFocus
            maxLength={100}
            placeholder="Claude Desktop, Cursor, Codex…"
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
        <Button type="submit" disabled={!!invalid} busy={saving} busyLabel="Saving…">
          {editing ? "Save access" : "Create access"}
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
  serverUrl = mcpServerUrl(),
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: TokenDialogMode;
  catalog: GrantCatalog | undefined;
  onSaved: () => void;
  /** The MCP server address for the ready-made configs. */
  serverUrl?: string;
}) {
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);
  // Reset the one-time reveal when the dialog re-opens (not on close, so the
  // exit animation keeps showing what the user was looking at).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setCreated(null);
      setTokenSaved(false);
    }
  }

  const close = () => onOpenChange(false);
  // While an unsaved token is on screen, Esc and outside clicks don't close.
  const guard = (event: Event) => {
    if (created && !tokenSaved) event.preventDefault();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onEscapeKeyDown={guard}
        onPointerDownOutside={guard}
        onInteractOutside={guard}
      >
        {created ? (
          <TokenReveal
            created={created}
            serverUrl={serverUrl}
            saved={tokenSaved}
            onSaved={() => setTokenSaved(true)}
            onDone={close}
          />
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
