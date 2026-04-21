"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ServiceConfig {
  image?: string;
  ports?: string[];
  environment?: Record<string, string> | string[];
  volumes?: string[];
  deploy?: {
    resources?: {
      limits?: { memory?: string; cpus?: string };
    };
  };
}

interface ComposeConfig {
  services?: Record<string, ServiceConfig>;
}

interface ConfigResponse {
  appId: string;
  composePath: string;
  config: ComposeConfig;
}

function PortEditor({ appId, ports, onSaved }: { appId: string; ports: string[]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    const d: Record<string, string> = {};
    for (const p of ports) {
      const [host, container] = p.split(":");
      d[container] = host;
    }
    setDraft(d);
    setEditing(true);
  };

  const handleSave = async () => {
    const portMap: Record<string, number> = {};
    let hasChange = false;
    for (const p of ports) {
      const [host, container] = p.split(":");
      const val = parseInt(draft[container] || host, 10);
      if (!isNaN(val) && val !== parseInt(host, 10)) { portMap[container] = val; hasChange = true; }
    }
    if (!hasChange) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/user-apps/${appId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName: Object.keys(draft).length ? undefined : undefined, ports: portMap }),
      });
      if (res.ok) {
        toast.success("Port mappings updated. Restart the container to apply.");
        onSaved();
        setEditing(false);
      } else {
        const d = await res.json() as { error?: string };
        toast.error(d.error ?? "Failed to save");
      }
    } catch { toast.error("Network error"); }
    finally { setSaving(false); }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Port Mappings</h2>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={startEditing}>Edit</Button>
        )}
      </div>
      <div className="space-y-2">
        {ports.map((p) => {
          const [host, container] = p.split(":");
          return (
            <div key={p} className="flex items-center gap-3 text-sm">
              {editing ? (
                <Input
                  value={draft[container] ?? host}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [container]: e.target.value }))}
                  className="font-mono text-xs h-8 w-20"
                />
              ) : (
                <Badge variant="outline" className="font-mono">{host}</Badge>
              )}
              <span className="text-muted-foreground">→</span>
              <Badge variant="secondary" className="font-mono">{container}</Badge>
              <span className="text-xs text-muted-foreground">(host → container)</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function normaliseEnv(env: Record<string, string> | string[] | undefined): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    return Object.fromEntries(env.map((e) => e.split("=", 2) as [string, string]));
  }
  return env;
}

export default function ConfigurePage() {
  const params = useParams<{ storeId: string; appId: string }>();
  const appId = params.appId;

  const { data, error, mutate } = useSWR<ConfigResponse>(
    `/api/user-apps/${appId}/config`,
    fetcher,
  );

  const [saving, setSaving] = useState(false);
  const [editedEnv, setEditedEnv] = useState<Record<string, string> | null>(null);

  if (error) {
    return (
      <div className="p-6 text-destructive">
        Failed to load config: {error?.message ?? "Unknown error"}
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-muted-foreground">Loading configuration...</div>;
  }

  const services = data.config?.services ?? {};
  const serviceNames = Object.keys(services);
  const primaryService = serviceNames[0];
  const service = services[primaryService];

  const currentEnv = editedEnv ?? normaliseEnv(service?.environment);

  async function handleSave() {
    if (!editedEnv || !primaryService) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/user-apps/${appId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName: primaryService, env: editedEnv }),
      });
      if (res.ok) {
        toast.success("Configuration saved. Restart the container to apply changes.");
        mutate();
        setEditedEnv(null);
      } else {
        const d = await res.json() as { error?: string };
        toast.error(d.error ?? "Failed to save");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  }

  const isDirty = editedEnv !== null;

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-medium">{appId} — Configure</h1>
        <p className="text-muted-foreground text-sm mt-1">{data.composePath}</p>
      </div>

      {/* Image */}
      {service?.image && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Image</h2>
          <code className="text-sm bg-muted px-2 py-1 rounded">{service.image}</code>
        </section>
      )}

      <Separator />

      {/* Environment Variables */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Environment Variables</h2>
          {isDirty && (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditedEnv(null)}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {Object.entries(currentEnv).map(([key, value]) => (
            <div key={key} className="grid grid-cols-[1fr_2fr] gap-3 items-center">
              <Label className="font-mono text-xs truncate" title={key}>
                {key}
              </Label>
              <Input
                value={value}
                onChange={(e) =>
                  setEditedEnv({ ...currentEnv, [key]: e.target.value })
                }
                className="font-mono text-xs h-8"
                type={key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") || key.toLowerCase().includes("password") ? "password" : "text"}
              />
            </div>
          ))}
          {Object.keys(currentEnv).length === 0 && (
            <p className="text-sm text-muted-foreground">No environment variables defined.</p>
          )}
        </div>
      </section>

      <Separator />

      {/* Ports */}
      {service?.ports && service.ports.length > 0 && (
        <PortEditor appId={appId} ports={service.ports} onSaved={() => mutate()} />
      )}

      {/* Volumes */}
      {service?.volumes && service.volumes.length > 0 && (
        <>
          <Separator />
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Volume Mounts</h2>
            <div className="space-y-1">
              {service.volumes.map((v) => (
                <code key={v} className="block text-xs bg-muted px-2 py-1 rounded">{v}</code>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Resource Limits */}
      {service?.deploy?.resources?.limits && (
        <>
          <Separator />
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Resource Limits</h2>
            <div className="flex gap-4 text-sm">
              {service.deploy.resources.limits.memory && (
                <div>
                  <span className="text-muted-foreground">Memory: </span>
                  <Badge variant="outline">{service.deploy.resources.limits.memory}</Badge>
                </div>
              )}
              {service.deploy.resources.limits.cpus && (
                <div>
                  <span className="text-muted-foreground">CPUs: </span>
                  <Badge variant="outline">{service.deploy.resources.limits.cpus}</Badge>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
