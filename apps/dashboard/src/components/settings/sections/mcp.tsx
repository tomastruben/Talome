"use client";

import { useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon, Add01Icon, Plug02Icon } from "@/components/icons";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import { TokenDialog, type TokenDialogMode } from "@/components/trust/token-dialog";
import { MCP_CATALOG_URL, MCP_CLIENT_FILES, MCP_TOKENS_URL, mcpClientConfig, mcpServerUrl, revokeMcpToken, trustFetcher } from "@/components/trust/api";
import { CopyButton } from "@/components/ui/copy-button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { AlertCircleIcon } from "@/components/icons";
import {
  formatExpiry,
  isExpired,
  summarizeScopes,
  type GrantCatalog,
  type McpToken,
} from "@/components/trust/format";

const subscribeNoop = () => () => {};
const clientServerUrl = () => mcpServerUrl();
const serverSnapshotUrl = () => mcpServerUrl("http://localhost:3000");

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
    <SettingsRow className="flex-col @lg:flex-row gap-3 items-start">
      <div className="w-full @lg:w-auto @lg:flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <p className="text-sm font-medium break-words min-w-0">{token.name}</p>
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
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" className="pointer-coarse:h-11" aria-label={`${token.legacy ? "Restrict" : "Edit"} ${token.name}'s access`} onClick={onEdit}>
          {token.legacy ? "Restrict" : "Edit"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="pointer-coarse:h-11 text-status-critical hover:text-status-critical"
          aria-label={`Revoke ${token.name}'s access`}
          onClick={onRevoke}
        >
          Revoke…
        </Button>
      </div>
    </SettingsRow>
  );
}

export function McpSection() {
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<TokenDialogMode>({ kind: "create" });
  const confirm = useConfirm();

  const revoke = async (token: McpToken) => {
    const { confirmed } = await confirm({
      tier: "destructive",
      title: `Revoke ${token.name}'s access?`,
      consequence: `${token.name} can't call Talome any more, and automations it created stop running.`,
      recovery: "Its past actions stay in the audit log. To reconnect it, create new access.",
      confirmLabel: "Revoke access",
      busyLabel: `Revoking ${token.name}'s access…`,
      run: () => revokeMcpToken(token.id),
      receipt: `Revoked ${token.name}'s access`,
    });
    if (confirmed) void mutateMcpTokens();
  };

  const {
    data: mcpTokens,
    error: tokensError,
    isLoading,
    mutate: mutateMcpTokens,
  } = useSWR<McpToken[]>(MCP_TOKENS_URL, trustFetcher, { revalidateOnFocus: false });
  const { data: catalog } = useSWR<GrantCatalog>(MCP_CATALOG_URL, trustFetcher, { revalidateOnFocus: false });

  const serverUrl = useSyncExternalStore(subscribeNoop, clientServerUrl, serverSnapshotUrl);

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
        <SettingsRow className="flex-col items-stretch gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Server URL</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Use this address to connect an AI client to Talome over HTTPS or Tailscale.
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {serverUrl}
            </code>
            <CopyButton value={serverUrl} label="Copy MCP server URL" size="sm" className="h-7 text-xs shrink-0" />
          </div>
        </SettingsRow>
      </SettingsGroup>

      {/* Tokens */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="flex-1 text-sm font-medium text-foreground">Connected agents</p>
          {tokens.length > 0 && (
            <Button size="sm" className="h-7 text-xs" onClick={openCreate}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              Connect an agent
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
            <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} className="shrink-0 text-status-critical" aria-hidden="true" />
            <p role="alert" className="flex-1 text-xs text-muted-foreground">
              {tokens.length > 0
                ? "Couldn't refresh the agent list. Showing what was loaded last."
                : `Couldn't load connected agents${tokensError instanceof Error ? `: ${tokensError.message}` : "."}`}
            </p>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void mutateMcpTokens()}>
              Retry
            </Button>
          </SettingsRow>
        )}

        {!isLoading && !tokensError && tokens.length === 0 && (
          <SettingsRow className="flex-col items-center text-center py-8 gap-3">
            <HugeiconsIcon icon={Plug02Icon} size={24} className="text-dim-foreground" />
            <div className="grid gap-1">
              <p className="text-sm font-medium">No agents connected</p>
              <p className="text-xs text-muted-foreground">New access is read-only unless you grant more.</p>
            </div>
            <Button size="sm" onClick={openCreate}>
              <HugeiconsIcon icon={Add01Icon} size={14} />
              Connect an agent
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
            onRevoke={() => void revoke(token)}
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
            {(["claude-code", "claude-desktop", "cursor"] as const).map((client) => (
              <div key={client}>
                <p className="text-xs font-medium text-muted-foreground mb-1.5 px-1">
                  {MCP_CLIENT_FILES[client].name} &mdash; {MCP_CLIENT_FILES[client].file}
                </p>
                <pre className="text-xs font-mono bg-muted/40 rounded-xl border border-border px-4 py-3 overflow-x-auto max-w-full">
                  {mcpClientConfig(client, serverUrl, "YOUR_TOKEN")}
                </pre>
              </div>
            ))}
            <p className="text-xs text-muted-foreground px-1">
              Replace <span className="font-mono">YOUR_TOKEN</span> with the access token. When you connect a new agent,
              Talome offers these snippets with the token already filled in. Claude Desktop only starts local servers, so
              it connects through mcp-remote, which needs Node.js on that computer. Claude Code running in the Talome
              repo on this machine connects over stdio and needs no token.
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
        serverUrl={serverUrl}
      />
    </div>
  );
}
