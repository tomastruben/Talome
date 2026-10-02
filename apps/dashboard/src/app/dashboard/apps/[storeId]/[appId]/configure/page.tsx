"use client";

import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { describeComposePort, normalizeComposeEnvironment } from "@talome/types";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

async function configFetcher(url: string): Promise<ConfigResponse> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Failed to load configuration");
  return body;
}

interface ServiceConfig {
  image?: string;
  ports?: unknown[];
  environment?: Record<string, string> | string[];
  volumes?: unknown[];
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

function PortEditor({ appId, serviceName, ports, onSaved }: { appId: string; serviceName: string; ports: unknown[]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mappings = ports.map(describeComposePort);

  const startEditing = () => {
    setDraft(Object.fromEntries(mappings.map((port, index) => [index, port?.published ?? ""])));
    setSaveError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    const portMappings: { index: number; published: number }[] = [];
    for (let index = 0; index < mappings.length; index++) {
      const port = mappings[index];
      if (!port?.editable || draft[index] === port.published) continue;
      const text = draft[index]?.trim() ?? "";
      const published = Number(text);
      if (!/^\d+$/.test(text) || published < 1 || published > 65535) {
        setSaveError("Enter a whole host port from 1 to 65535.");
        return;
      }
      portMappings.push({ index, published });
    }
    if (!portMappings.length) { setEditing(false); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/user-apps/${appId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceName, portMappings }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to save port mappings");
      }
      toast.success("Port mappings saved. Recreate the app to apply changes.");
      onSaved();
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Network error");
    } finally { setSaving(false); }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="port-mappings-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="port-mappings-title" className="text-sm font-medium">Port Mappings</h2>
        {editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setSaveError(null); }}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save ports"}</Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={startEditing} disabled={!mappings.some((port) => port?.editable)}>Edit ports</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Host port → container port. Bind addresses and protocols are preserved.</p>
      <div className="flex flex-col gap-2">
        {mappings.map((port, index) => (
          <div key={index} className="flex flex-wrap items-center gap-3 text-sm">
            {editing && port?.editable ? (
              <Input
                aria-label={`Host port for ${port.target}/${port.protocol}${port.binding ? ` on ${port.binding}` : ""}`}
                aria-invalid={!!saveError}
                aria-describedby={saveError ? "port-error" : undefined}
                inputMode="numeric"
                value={draft[index] ?? port.published}
                disabled={saving}
                onChange={(e) => { setDraft((prev) => ({ ...prev, [index]: e.target.value })); setSaveError(null); }}
                className="w-24"
                placeholder="Automatic"
              />
            ) : <Badge variant="outline" className="max-w-full break-all whitespace-normal">{port?.published || "Automatic"}</Badge>}
            <span aria-hidden className="text-muted-foreground">→</span>
            <Badge variant="secondary" className="max-w-full break-all whitespace-normal">{port ? `${port.target}/${port.protocol}` : "Unsupported mapping"}</Badge>
            {port?.binding && <span className="text-xs text-muted-foreground break-all">{port.binding}</span>}
            {port && !port.editable && <span className="text-xs text-muted-foreground">Edit ranges or variables in Compose</span>}
          </div>
        ))}
      </div>
      {saveError && <Alert variant="destructive" id="port-error"><AlertDescription>{saveError}</AlertDescription></Alert>}
    </section>
  );
}

export default function ConfigurePage() {
  const params = useParams<{ storeId: string; appId: string }>();
  const appId = params.appId;
  const embedded = useIsEmbeddedFrame();
  const setPageTitle = useSetAtom(pageTitleAtom);
  useEffect(() => {
    setPageTitle(`${appId} · Configure`);
    return () => setPageTitle(null);
  }, [appId, setPageTitle]);

  const { data, error, mutate } = useSWR<ConfigResponse>(
    `/api/user-apps/${appId}/config`,
    configFetcher,
  );

  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editedEnv, setEditedEnv] = useState<Record<string, string> | null>(null);

  if (error) {
    return (
      <div><Alert variant="destructive">
        <AlertTitle>Configuration unavailable</AlertTitle>
        <AlertDescription>{error?.message ?? "Unknown error"}<Button variant="outline" size="sm" onClick={() => mutate()}>Try again</Button></AlertDescription>
      </Alert></div>
    );
  }

  if (!data) {
    return <div className="text-sm text-muted-foreground" aria-busy="true">Loading configuration…</div>;
  }

  const services = data.config?.services ?? {};
  const serviceNames = Object.keys(services);
  const primaryService = selectedService && services[selectedService] ? selectedService : serviceNames[0];
  const service = services[primaryService];

  const currentEnv = { ...normalizeComposeEnvironment(service?.environment), ...editedEnv };

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
        toast.success("Configuration saved. Recreate the app to apply changes.");
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
    // The shell pads the page (classic and window alike); this adds none of its own
    <div className="@container max-w-3xl min-w-0 flex flex-col gap-8">
      <div>
        <h1 className={embedded ? "sr-only" : "text-2xl font-medium break-words"}>{appId} — Configure</h1>
        <p className="text-muted-foreground text-sm mt-1 break-all">{data.composePath}</p>
      </div>

      {serviceNames.length > 1 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="configure-service">Service</Label>
          <Select value={primaryService} disabled={saving || editedEnv !== null} onValueChange={setSelectedService}>
            <SelectTrigger id="configure-service"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{serviceNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          {editedEnv !== null && <p className="text-xs text-muted-foreground">Save or reset changes before switching services.</p>}
        </div>
      )}
      {!service && <Alert><AlertDescription>No services are defined in this configuration.</AlertDescription></Alert>}

      {/* Image */}
      {service?.image && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Image</h2>
          <code className="text-sm bg-muted px-2 py-1 rounded break-all">{service.image}</code>
        </section>
      )}

      <Separator />

      {/* Environment Variables */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Environment variables</h2>
          {isDirty && (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditedEnv(null)}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          {Object.entries(currentEnv).map(([key, value]) => (
            <div key={key} className="grid grid-cols-1 @lg:grid-cols-[1fr_2fr] gap-2 @lg:gap-3 @lg:items-center">
              <Label htmlFor={`env-${key}`} className="font-mono text-xs truncate" title={key}>
                {key}
              </Label>
              <Input
                id={`env-${key}`}
                value={value ?? ""}
                placeholder={value === null ? "Inherited from host" : undefined}
                disabled={saving}
                onChange={(e) =>
                  setEditedEnv({ ...editedEnv, [key]: e.target.value })
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
        <PortEditor key={primaryService} appId={appId} serviceName={primaryService} ports={service.ports} onSaved={() => mutate()} />
      )}

      {/* Volumes */}
      {service?.volumes && service.volumes.length > 0 && (
        <>
          <Separator />
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Volume Mounts</h2>
            <div className="flex flex-col gap-1">
              {service.volumes.map((v, index) => (
                <code key={index} className="block text-xs bg-muted px-2 py-1 rounded break-all">{typeof v === "string" ? v : JSON.stringify(v)}</code>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Resource Limits */}
      {service?.deploy?.resources?.limits && (
        <>
          <Separator />
          <section className="flex flex-col gap-3">
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
