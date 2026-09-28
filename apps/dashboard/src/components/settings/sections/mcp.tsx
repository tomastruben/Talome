"use client";

import { useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon, Add01Icon, Plug02Icon } from "@/components/icons";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, relativeTime, copyToClipboard } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import { TokenDialog, type TokenDialogMode } from "@/components/trust/token-dialog";
import { MCP_CATALOG_URL, MCP_TOKENS_URL, revokeMcpToken, trustFetcher } from "@/components/trust/api";
import {
  formatExpiry,
  isExpired,
  summarizeScopes,
  type GrantCatalog,
  type McpToken,
} from "@/components/trust/format";

const DEFAULT_SERVER_URL = "http://localhost:4000/api/mcp";
const subscribeNoop = () => () => {};
const clientServerUrl = () => `http://${window.location.hostname}:4000/api/mcp`;

function TokenRow({
  token,
  onEdit,
  onRevoke,
}: {
  token: McpToken;
  onEdit: () => void;
  onRevoke: () => void;
}) {
  const expired = isExpired(token.expiresAt);
  return (
    <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2 items-start">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium truncate">{token.name}</p>
          {token.legacy && (
            <Badge variant="outline" className="text-status-warning border-status-warning/30">
              Legacy full access
            </Badge>
          )}
          {expired && <Badge variant="outline" className="text-muted-foreground">Expired</Badge>}
        </div>
        {!token.legacy && (
          <p className="text-xs text-muted-foreground mt-0.5">{summarizeScopes(token.scopes)}</p>
        )}
        <p className="text-xs text-muted-foreground mt-0.5">
          Created {relativeTime(token.createdAt)}
          {" · "}
          {token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : "Never used"}
          {!expired && ` · ${formatExpiry(token.expiresAt)}`}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onEdit}>
          {token.legacy ? "Restrict" : "Edit"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-destructive/70 hover:text-destructive"
          onClick={onRevoke}
        >
          Revoke
        </Button>
      </div>
    </SettingsRow>
  );
}

function RevokeDialog({
  token,
  onOpenChange,
  onRevoked,
}: {
  token: McpToken | null;
  onOpenChange: (open: boolean) => void;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  return (
    <Dialog open={token !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {token?.name}?</DialogTitle>
          <DialogDescription>
            The client stops working immediately. Its past actions stay in the audit log.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={revoking}
            onClick={async () => {
              if (!token) return;
              setRevoking(true);
              try {
                await revokeMcpToken(token.id);
                toast.success(`${token.name} revoked`);
                onRevoked();
                onOpenChange(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not revoke token");
              } finally {
                setRevoking(false);
              }
            }}
          >
            {revoking ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function McpSection() {
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<TokenDialogMode>({ kind: "create" });
  const [revoking, setRevoking] = useState<McpToken | null>(null);

  const {
    data: mcpTokens,
    error: tokensError,
    isLoading,
    mutate: mutateMcpTokens,
  } = useSWR<McpToken[]>(MCP_TOKENS_URL, trustFetcher, { revalidateOnFocus: false });
  const { data: catalog } = useSWR<GrantCatalog>(MCP_CATALOG_URL, trustFetcher, { revalidateOnFocus: false });

  const mcpServerUrl = useSyncExternalStore(subscribeNoop, clientServerUrl, () => DEFAULT_SERVER_URL);

  const tokens = Array.isArray(mcpTokens) ? mcpTokens : [];
  const hasLegacy = tokens.some((t) => t.legacy);

  const openCreate = () => {
    setDialogMode({ kind: "create" });
    setDialogOpen(true);
  };

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Let AI clients like Claude Desktop, Cursor, or Claude Code on another machine use Talome. Each client gets
        its own token with only the access you grant — every call is checked and recorded in the audit log.
      </p>

      {/* Connection */}
      <SettingsGroup>
        <SettingsRow className="flex-wrap gap-y-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Server URL</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Uses your current hostname — works with Tailscale, LAN IPs, or custom domains
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <span className="flex-1 sm:flex-none text-xs font-mono text-muted-foreground bg-muted/40 px-2.5 py-1.5 rounded-lg truncate max-w-[240px] sm:max-w-none">
              {mcpServerUrl}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs shrink-0"
              onClick={async () => {
                const copied = await copyToClipboard(mcpServerUrl);
                if (!copied) { toast.error("Clipboard unavailable"); return; }
                setMcpUrlCopied(true);
                setTimeout(() => setMcpUrlCopied(false), 2000);
              }}
            >
              {mcpUrlCopied ? "Copied" : "Copy"}
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      {/* Tokens */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tokens</p>
          {tokens.length > 0 && (
            <Button size="sm" className="h-7 text-xs" onClick={openCreate}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              New token
            </Button>
          )}
        </SettingsRow>

        {hasLegacy && (
          <SettingsRow className="bg-status-warning/5">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Tokens marked <span className="text-status-warning">Legacy full access</span> were created before access
              controls and can do anything. Restrict them to what each client needs.
            </p>
          </SettingsRow>
        )}

        {isLoading && (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-56" />
            </div>
          </SettingsRow>
        )}

        {tokensError && (
          <SettingsRow>
            <p className="text-xs text-muted-foreground">
              {tokensError instanceof Error ? tokensError.message : "Could not load tokens"}
            </p>
          </SettingsRow>
        )}

        {!isLoading && !tokensError && tokens.length === 0 && (
          <SettingsRow className="flex-col items-center text-center py-8 gap-3">
            <HugeiconsIcon icon={Plug02Icon} size={24} className="text-dim-foreground" />
            <div className="grid gap-1">
              <p className="text-sm font-medium">No agents connected</p>
              <p className="text-xs text-muted-foreground">New tokens are read-only unless you grant more.</p>
            </div>
            <Button size="sm" onClick={openCreate}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              New token
            </Button>
          </SettingsRow>
        )}

        {tokens.map((token) => (
          <TokenRow
            key={token.id}
            token={token}
            onEdit={() => {
              setDialogMode({ kind: "edit", token });
              setDialogOpen(true);
            }}
            onRevoke={() => setRevoking(token)}
          />
        ))}
      </SettingsGroup>

      {/* Connection snippets */}
      <Collapsible open={snippetsOpen} onOpenChange={setSnippetsOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
          >
            <HugeiconsIcon icon={snippetsOpen ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
            Connection snippets
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 px-1">Cursor &mdash; .cursor/mcp.json</p>
              <pre className="text-xs font-mono bg-muted/40 rounded-xl border border-border px-4 py-3 overflow-x-auto max-w-full">{JSON.stringify({
                mcpServers: {
                  talome: {
                    url: mcpServerUrl,
                    headers: { Authorization: "Bearer YOUR_TOKEN" },
                  },
                },
              }, null, 2)}</pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 px-1">Claude Desktop &mdash; claude_desktop_config.json</p>
              <pre className="text-xs font-mono bg-muted/40 rounded-xl border border-border px-4 py-3 overflow-x-auto max-w-full">{JSON.stringify({
                mcpServers: {
                  talome: {
                    type: "http",
                    url: mcpServerUrl,
                    headers: { Authorization: "Bearer YOUR_TOKEN" },
                  },
                },
              }, null, 2)}</pre>
            </div>
            <p className="text-xs text-muted-foreground px-1">
              Replace <span className="font-mono">YOUR_TOKEN</span> with the token you created. Claude Code running in
              the Talome repo on this machine connects over stdio and needs no token.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConfigureWithAI prompt="I'd like to connect external tools to Talome via MCP" />

      <TokenDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        catalog={catalog}
        onSaved={() => void mutateMcpTokens()}
      />
      <RevokeDialog
        token={revoking}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        onRevoked={() => void mutateMcpTokens()}
      />
    </div>
  );
}
