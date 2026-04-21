"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, relativeTime, copyToClipboard } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

export function McpSection() {
  const [mcpTokenName, setMcpTokenName] = useState("");
  const [mcpGenerating, setMcpGenerating] = useState(false);
  const [mcpNewToken, setMcpNewToken] = useState<{ id: string; name: string; token: string } | null>(null);
  const [mcpTokenCopied, setMcpTokenCopied] = useState(false);
  const [mcpUrlCopied, setMcpUrlCopied] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const { data: mcpTokens, mutate: mutateMcpTokens } = useSWR<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }[]>(
    `${CORE_URL}/api/integrations/mcp/tokens`,
    (url: string) => fetch(url).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const [mcpServerUrl, setMcpServerUrl] = useState("http://localhost:4000/api/mcp");
  useEffect(() => {
    setMcpServerUrl(`http://${window.location.hostname}:4000/api/mcp`);
  }, []);

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Talome exposes an MCP server so external AI clients can use all of Talome's tools — Docker management, media, automations, and more. Generate a token, then add the connection to your client.
      </p>

      {/* Server URL + token generation */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connection</p>
        </SettingsRow>

        {/* Server URL */}
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

        {/* Generate token */}
        <SettingsRow className="flex-wrap gap-y-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Generate Token</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each client should have its own token
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Input
              className="h-8 flex-1 sm:w-40 text-sm"
              placeholder="e.g. Cursor, Claude Desktop"
              value={mcpTokenName}
              onChange={(e) => setMcpTokenName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("mcp-generate-btn")?.click(); }}
            />
            <Button
              id="mcp-generate-btn"
              size="sm"
              variant="secondary"
              className="h-8 text-xs px-3 shrink-0"
              disabled={mcpGenerating || !mcpTokenName.trim()}
              onClick={async () => {
                setMcpGenerating(true);
                setMcpNewToken(null);
                try {
                  const res = await fetch(`${CORE_URL}/api/integrations/mcp/tokens`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: mcpTokenName.trim() }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    setMcpNewToken({ id: data.id, name: data.name, token: data.token });
                    setMcpTokenName("");
                    mutateMcpTokens();
                  } else {
                    toast.error(data.error ?? "Failed to generate token");
                  }
                } catch {
                  toast.error("Failed to generate token");
                } finally {
                  setMcpGenerating(false);
                }
              }}
            >
              {mcpGenerating ? "Generating..." : "Generate"}
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      {/* One-time token reveal */}
      {mcpNewToken && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2">
          <p className="text-xs font-medium text-status-warning">
            Save this token — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-background/60 rounded-lg px-3 py-2 border border-border break-all min-w-0">
              {mcpNewToken.token}
            </code>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs shrink-0"
              onClick={async () => {
                const copied = await copyToClipboard(mcpNewToken.token);
                if (!copied) { toast.error("Clipboard unavailable"); return; }
                setMcpTokenCopied(true);
                setTimeout(() => setMcpTokenCopied(false), 2000);
              }}
            >
              {mcpTokenCopied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs text-muted-foreground"
            onClick={() => setMcpNewToken(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Active tokens */}
      {mcpTokens && mcpTokens.length > 0 && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Active Tokens</p>
          </SettingsRow>
          {mcpTokens.map((token) => (
            <SettingsRow key={token.id}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{token.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Created {relativeTime(token.createdAt)}
                  {token.lastUsedAt && ` · Last used ${relativeTime(token.lastUsedAt)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive/70 hover:text-destructive shrink-0"
                onClick={async () => {
                  await fetch(`${CORE_URL}/api/integrations/mcp/tokens/${token.id}`, { method: "DELETE" });
                  mutateMcpTokens();
                  toast.success("Token revoked");
                }}
              >
                Revoke
              </Button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

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
              Replace <span className="font-mono">YOUR_TOKEN</span> with the token you generated above. If you access Talome via Tailscale or a custom domain, the URL above already reflects that.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConfigureWithAI prompt="I'd like to connect external tools to Talome via MCP" />
    </div>
  );
}
