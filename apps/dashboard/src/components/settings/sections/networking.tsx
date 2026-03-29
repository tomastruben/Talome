"use client";

import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HugeiconsIcon,
  Globe02Icon,
  Shield01Icon,
  Delete01Icon,
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  LinkSquare01Icon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, SaveRow } from "@/components/settings/settings-primitives";
import { useUser } from "@/hooks/use-user";

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

/* ── Types ─────────────────────────────────────────────── */

interface ProxyRoute {
  id: string;
  app_id: string | null;
  domain: string;
  upstream: string;
  tls_mode: string;
  enabled: number;
  cert_status: string;
  cert_error: string | null;
  created_at: string;
}

interface ProxyData {
  running: boolean;
  containerStatus?: string;
  routeCount: number;
  routes: ProxyRoute[];
}

interface LocalDomainsStatus {
  enabled: boolean;
  baseDomain: string;
  serverIp: string;
  dns: { running: boolean };
  proxy: { running: boolean; routeCount: number };
  mdns: { running: boolean };
  caCertAvailable: boolean;
  serverConfigured: boolean;
}

/* ── Local Domains Section ───────────────────────────── */

function LocalDomainsSection({
  proxyData,
  mutateProxy,
}: {
  proxyData: ProxyData | undefined;
  mutateProxy: () => void;
}) {
  const { data: status, mutate: mutateStatus } = useSWR<LocalDomainsStatus>(
    `${CORE_URL}/api/network/status`,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const [baseDomain, setBaseDomain] = useState("talome.local");
  const [enabling, setEnabling] = useState(false);
  const [applying, setApplying] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (status && !loaded) {
      setBaseDomain(status.baseDomain || "talome.local");
      setLoaded(true);
    }
  }, [status, loaded]);

  const isEnabled = status?.enabled ?? false;
  const appRoutes = proxyData?.routes?.filter((r) => r.app_id) ?? [];

  async function handleToggle(enable: boolean) {
    setEnabling(true);
    try {
      if (enable) {
        const res = await fetch(`${CORE_URL}/api/network/enable`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ baseDomain }),
        });
        const data = await res.json() as { ok?: boolean; error?: string; proxyRoutes?: string[] };
        if (!res.ok || !data.ok) {
          toast.error(data.error || "Failed to enable");
          return;
        }
        toast.success(`Local domains enabled — ${data.proxyRoutes?.length ?? 0} route(s) created`);
      } else {
        await fetch(`${CORE_URL}/api/network/disable`, {
          method: "POST",
          credentials: "include",
        });
        toast.success("Local domains disabled");
      }
      mutateStatus();
      mutateProxy();
    } catch {
      toast.error("Network error");
    } finally {
      setEnabling(false);
    }
  }

  async function handleApplyToApps() {
    if (!baseDomain) return;
    setApplying(true);
    try {
      const res = await fetch(`${CORE_URL}/api/proxy/apply-domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ baseDomain, tlsMode: "selfsigned" }),
      });
      const data = await res.json() as { ok: boolean; created: string[]; skipped: number };
      if (data.created.length > 0) {
        toast.success(`Created ${data.created.length} route(s)`);
      } else {
        toast.info("All apps already have routes");
      }
      mutateProxy();
    } catch {
      toast.error("Failed to apply domain");
    } finally {
      setApplying(false);
    }
  }

  const setupCommand = status
    ? `curl -fsSL http://${status.serverIp}:4000/api/network/setup.sh | sudo bash`
    : "";
  const setupPs1 = status
    ? `irm http://${status.serverIp}:4000/api/network/setup.ps1 | iex`
    : "";

  return (
    <div className="grid gap-6">
      {/* Main controls */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Local Domains</p>
          <div className="ml-auto flex items-center gap-2">
            {status?.dns.running && (
              <Badge variant="secondary" className="text-xs gap-1.5 px-2 py-0">
                <span className="size-1.5 rounded-full bg-status-healthy" />
                DNS
              </Badge>
            )}
            {status?.proxy.running && (
              <Badge variant="secondary" className="text-xs gap-1.5 px-2 py-0">
                <span className="size-1.5 rounded-full bg-status-healthy" />
                Proxy
              </Badge>
            )}
            {isEnabled && (
              <Badge variant="secondary" className="text-xs gap-1.5 px-2 py-0">
                <span className={`size-1.5 rounded-full ${status?.serverConfigured ? 'bg-status-healthy' : 'bg-status-warning'}`} />
                Server
              </Badge>
            )}
          </div>
        </SettingsRow>

        <SettingsRow>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Enable local domains</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isEnabled
                ? <>Dashboard at <span className="font-mono text-foreground">home.{status?.baseDomain}</span> &middot; Apps at <span className="font-mono text-foreground">appname.{status?.baseDomain}</span></>
                : <>Access your dashboard and every app via clean local URLs</>
              }
            </p>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggle}
            disabled={enabling}
          />
        </SettingsRow>

        {!isEnabled && (
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label htmlFor="base-domain" className="text-sm font-medium cursor-pointer">Base domain</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Wildcard DNS resolves all subdomains automatically
              </p>
            </div>
            <div className="shrink-0 w-full sm:w-56">
              <Input
                id="base-domain"
                placeholder="talome.local"
                value={baseDomain}
                onChange={(e) => setBaseDomain(e.target.value)}
                className="text-sm h-8"
              />
            </div>
          </SettingsRow>
        )}

        {isEnabled && (
          <>
            <SettingsRow>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Server</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  <span className="font-mono text-foreground">{status?.serverIp}</span>
                  {" · "}
                  All <span className="font-mono text-foreground">*.{status?.baseDomain}</span> traffic routes here
                </p>
              </div>
            </SettingsRow>

            <SettingsRow>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Apply to installed apps</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {appRoutes.length > 0
                    ? `${appRoutes.length} app${appRoutes.length !== 1 ? "s" : ""} routed`
                    : "Create routes for all installed apps"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-3 shrink-0"
                onClick={handleApplyToApps}
                disabled={applying}
              >
                {applying ? "Applying..." : "Apply domain"}
              </Button>
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      {/* Client setup instructions */}
      {isEnabled && status?.dns.running && (
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Client Setup</p>
          </SettingsRow>

          <SettingsRow>
            <div className="flex-1 min-w-0 space-y-3">
              <p className="text-sm text-muted-foreground">
                Set up once on each device that needs access:
              </p>

              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Phone / Tablet</p>
                <p className="text-xs text-muted-foreground leading-relaxed mb-1.5">
                  Open this guide on your device for step-by-step DNS and certificate setup:
                </p>
                <div className="flex items-start gap-2">
                  <a
                    href={`http://${status?.serverIp}:4000/api/network/setup`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-xs bg-muted/50 rounded-lg px-3 py-2 font-mono break-all leading-relaxed text-foreground underline underline-offset-2 decoration-muted-foreground/40 hover:decoration-foreground transition-colors"
                  >
                    http://{status?.serverIp}:4000/api/network/setup
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(`http://${status?.serverIp}:4000/api/network/setup`);
                      toast.success("Copied to clipboard");
                    }}
                  >
                    <span className="text-xs">Copy</span>
                  </Button>
                </div>
              </div>

              <div className="pt-1 border-t border-border/50">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Mac / Linux</p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-xs bg-muted/50 rounded-lg px-3 py-2 font-mono break-all leading-relaxed">
                    {setupCommand}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(setupCommand);
                      toast.success("Copied to clipboard");
                    }}
                  >
                    <span className="text-xs">Copy</span>
                  </Button>
                </div>
              </div>

              <div className="pt-1 border-t border-border/50">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Windows (PowerShell as Admin)</p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-xs bg-muted/50 rounded-lg px-3 py-2 font-mono break-all leading-relaxed">
                    {setupPs1}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(setupPs1);
                      toast.success("Copied to clipboard");
                    }}
                  >
                    <span className="text-xs">Copy</span>
                  </Button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                Sets DNS to resolve <span className="font-mono text-foreground">*.{status?.baseDomain}</span> via your server and trusts the HTTPS certificate.
              </p>
            </div>
          </SettingsRow>
        </SettingsGroup>
      )}
    </div>
  );
}

/* ── Routes Section ───────────────────────────────────── */

function RoutesSection({
  proxyData,
  mutateProxy,
  isAdmin,
}: {
  proxyData: ProxyData | undefined;
  mutateProxy: () => void;
  isAdmin: boolean;
}) {
  const [newDomain, setNewDomain] = useState("");
  const [newUpstream, setNewUpstream] = useState("");
  const [newTls, setNewTls] = useState("auto");
  const [adding, setAdding] = useState(false);
  const [showRouteForm, setShowRouteForm] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);

  const routes = proxyData?.routes ?? [];
  const appRoutes = useMemo(() => routes.filter((r) => r.app_id), [routes]);
  const customRoutes = useMemo(() => routes.filter((r) => !r.app_id), [routes]);

  async function handleAddRoute(e: React.FormEvent) {
    e.preventDefault();
    if (!newDomain || !newUpstream) return;
    setAdding(true);
    try {
      const res = await fetch(`${CORE_URL}/api/proxy/routes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ domain: newDomain, upstream: newUpstream, tlsMode: newTls }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        toast.error(typeof d.error === "string" ? d.error : "Failed to add route");
        return;
      }
      toast.success(`Route added: ${newDomain}`);
      setNewDomain(""); setNewUpstream(""); setNewTls("auto"); setShowRouteForm(false);
      mutateProxy();
    } catch { toast.error("Network error"); }
    finally { setAdding(false); }
  }

  async function handleDeleteRoute(id: string) {
    try {
      await fetch(`${CORE_URL}/api/proxy/routes/${id}`, { method: "DELETE", credentials: "include" });
      toast.success("Route removed"); mutateProxy();
    } catch { toast.error("Failed to remove"); }
  }

  async function handleToggleRoute(route: ProxyRoute) {
    try {
      await fetch(`${CORE_URL}/api/proxy/routes/${route.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: route.enabled !== 1 }),
      });
      mutateProxy();
    } catch { toast.error("Failed to update"); }
  }

  function certBadge(route: ProxyRoute) {
    const status = route.cert_status === "pending" && route.tls_mode === "selfsigned"
      ? "selfsigned"
      : route.cert_status;
    switch (status) {
      case "active": return <Badge variant="default" className="text-xs">Active</Badge>;
      case "selfsigned": return <Badge variant="secondary" className="text-xs">Self-signed</Badge>;
      case "error": return <Badge variant="destructive" className="text-xs">Error</Badge>;
      default: return <Badge variant="outline" className="text-xs">Pending</Badge>;
    }
  }

  function renderRoute(route: ProxyRoute) {
    return (
      <SettingsRow key={route.id} className="flex-wrap gap-y-1">
        <HugeiconsIcon
          icon={route.tls_mode === "off" ? Globe02Icon : Shield01Icon}
          size={16} className="text-muted-foreground shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{route.domain}</span>
            {certBadge(route)}
            {route.app_id && <Badge variant="outline" className="text-xs">{route.app_id}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{route.upstream}</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <Switch checked={route.enabled === 1} onCheckedChange={() => handleToggleRoute(route)} />
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleDeleteRoute(route.id)}>
              <HugeiconsIcon icon={Delete01Icon} size={14} />
            </Button>
          </div>
        )}
      </SettingsRow>
    );
  }

  if (routes.length === 0 && !showRouteForm) {
    return (
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Proxy Routes</p>
          <Badge variant="secondary" className="ml-auto text-xs">0</Badge>
        </SettingsRow>
        <SettingsRow>
          <p className="text-sm text-muted-foreground flex-1">No routes configured yet.</p>
          {isAdmin && (
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs gap-1.5 shrink-0" onClick={() => setShowRouteForm(true)}>
              <HugeiconsIcon icon={Add01Icon} size={12} />
              Add Route
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
    );
  }

  return (
    <Collapsible open={routesOpen} onOpenChange={setRoutesOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 w-full">
          <HugeiconsIcon icon={routesOpen ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
          <span className="font-medium uppercase tracking-wider">Proxy Routes</span>
          <span className="font-normal tabular-nums">{routes.length}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 grid gap-3">
          {appRoutes.length > 0 && (
            <SettingsGroup>
              <SettingsRow className="py-2.5">
                <HugeiconsIcon icon={LinkSquare01Icon} size={14} className="text-muted-foreground" />
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">App Subdomains</p>
                <Badge variant="secondary" className="ml-auto text-xs">{appRoutes.length}</Badge>
              </SettingsRow>
              {appRoutes.map(renderRoute)}
            </SettingsGroup>
          )}

          <SettingsGroup>
            <SettingsRow className="py-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Custom Routes</p>
              <Badge variant="secondary" className="ml-auto text-xs">{customRoutes.length}</Badge>
            </SettingsRow>
            {customRoutes.map(renderRoute)}

            {showRouteForm && isAdmin && (
              <SettingsRow className="flex-col items-stretch gap-3 py-4">
                <form onSubmit={handleAddRoute} className="grid gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Domain</Label>
                      <Input value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
                        placeholder="app.example.com" className="h-8 text-sm" autoFocus />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Upstream</Label>
                      <Input value={newUpstream} onChange={(e) => setNewUpstream(e.target.value)}
                        placeholder="container:8080" className="h-8 text-sm" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">TLS Mode</Label>
                      <Select value={newTls} onValueChange={setNewTls}>
                        <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Auto (Let&apos;s Encrypt)</SelectItem>
                          <SelectItem value="selfsigned">Self-signed (LAN)</SelectItem>
                          <SelectItem value="off">HTTP Only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" type="button" className="h-7 text-xs" onClick={() => setShowRouteForm(false)}>Cancel</Button>
                    <Button size="sm" type="submit" className="h-7 text-xs px-4" disabled={adding || !newDomain || !newUpstream}>
                      {adding ? "Adding..." : "Add"}
                    </Button>
                  </div>
                </form>
              </SettingsRow>
            )}

            {!showRouteForm && isAdmin && (
              <SettingsRow className="bg-muted/30 justify-end py-3">
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setShowRouteForm(true)}>
                  <HugeiconsIcon icon={Add01Icon} size={12} />
                  Add Route
                </Button>
              </SettingsRow>
            )}
          </SettingsGroup>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ── Auth Proxy Section ───────────────────────────────── */

function AuthProxySection() {
  const { data: settings, mutate: mutateSettings } = useSWR<Record<string, string>>(
    `${CORE_URL}/api/settings`,
    fetcher,
  );

  const [enabled, setEnabled] = useState(false);
  const [coreHost, setCoreHost] = useState("host.docker.internal:4000");
  const [bypassApps, setBypassApps] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (settings && !loaded) {
      setEnabled(settings.proxy_auth_enabled === "true");
      setCoreHost(settings.proxy_auth_core_host || "host.docker.internal:4000");
      setBypassApps(settings.proxy_auth_bypass_apps || "");
      setLoaded(true);
    }
  }, [settings, loaded]);

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        proxy_auth_enabled: enabled ? "true" : "false",
        proxy_auth_core_host: coreHost,
        proxy_auth_bypass_apps: bypassApps,
      };
      const res = await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast.error("Failed to save settings");
        return;
      }
      toast.success("Auth proxy settings saved");
      setDirty(false);
      mutateSettings();

      // Trigger Caddy reload to apply the new auth config
      await fetch(`${CORE_URL}/api/proxy/reload`, { method: "POST", credentials: "include" }).catch(() => {});
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <HugeiconsIcon icon={Shield01Icon} size={14} className="text-muted-foreground" />
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Auth Proxy</p>
      </SettingsRow>

      <SettingsRow>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Enable forward auth</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Protect all proxied apps with Talome login. Apps with built-in auth can be bypassed.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => { setEnabled(v); setDirty(true); }}
        />
      </SettingsRow>

      {enabled && (
        <>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label htmlFor="core-host" className="text-sm font-medium cursor-pointer">Core API host</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                How Caddy reaches the Talome API for session verification
              </p>
            </div>
            <div className="shrink-0 w-full sm:w-64">
              <Input
                id="core-host"
                placeholder="host.docker.internal:4000"
                value={coreHost}
                onChange={(e) => { setCoreHost(e.target.value); setDirty(true); }}
                className="text-sm h-8 font-mono"
              />
            </div>
          </SettingsRow>

          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label htmlFor="bypass-apps" className="text-sm font-medium cursor-pointer">Bypass apps</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Comma-separated app IDs that skip auth (e.g. vaultwarden, pihole)
              </p>
            </div>
            <div className="shrink-0 w-full sm:w-64">
              <Input
                id="bypass-apps"
                placeholder="vaultwarden, pihole"
                value={bypassApps}
                onChange={(e) => { setBypassApps(e.target.value); setDirty(true); }}
                className="text-sm h-8"
              />
            </div>
          </SettingsRow>
        </>
      )}

      {dirty && (
        <SaveRow onSave={handleSave} saving={saving} />
      )}
    </SettingsGroup>
  );
}

/* ── Main Section ─────────────────────────────────────── */

export function NetworkingSection() {
  const { isAdmin } = useUser();

  const { data: proxyData, mutate: mutateProxy } = useSWR<ProxyData>(
    `${CORE_URL}/api/proxy`,
    fetcher,
    { refreshInterval: 10_000 },
  );

  return (
    <div className="grid gap-8">
      <LocalDomainsSection proxyData={proxyData} mutateProxy={mutateProxy} />
      {isAdmin && <AuthProxySection />}
      <RoutesSection proxyData={proxyData} mutateProxy={mutateProxy} isAdmin={isAdmin} />
    </div>
  );
}
