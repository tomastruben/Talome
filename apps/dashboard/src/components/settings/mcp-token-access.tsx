"use client";

import useSWR from "swr";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CORE_URL } from "@/lib/constants";

export type McpTokenTier = "read" | "modify" | "destructive";

export interface McpTokenScope {
  maxTier: McpTokenTier;
  domains: "*" | string[];
  apps: "*" | string[];
}

interface ScopeOptions {
  domains: { name: string; toolCount: number }[];
  apps: { appId: string; name: string }[];
}

export const DEFAULT_SCOPE: McpTokenScope = { maxTier: "read", domains: "*", apps: "*" };

const ACCESS_LEVELS: { value: McpTokenTier; label: string; hint: string }[] = [
  { value: "read", label: "Read only", hint: "Can look at apps, logs and status. Cannot change anything." },
  { value: "modify", label: "Read and change", hint: "Can restart, configure and install. Cannot delete or run shell commands." },
  { value: "destructive", label: "Full control", hint: "Everything, including uninstalling and deleting. Destructive actions still need your approval in cautious mode." },
];

export function describeScope(scope: McpTokenScope): string {
  const level = ACCESS_LEVELS.find((l) => l.value === scope.maxTier)?.label ?? scope.maxTier;
  const apps = scope.apps === "*" ? "all apps" : scope.apps.length === 1 ? scope.apps[0] : `${scope.apps.length} apps`;
  const domains = scope.domains === "*" ? "" : ` · ${scope.domains.length} tool area${scope.domains.length === 1 ? "" : "s"}`;
  return `${level} · ${apps}${domains}`;
}

function toggle(list: "*" | string[], item: string, on: boolean): string[] {
  const current = list === "*" ? [] : list;
  return on ? [...new Set([...current, item])] : current.filter((i) => i !== item);
}

/** Access level, app and tool-area limits for one MCP token. */
export function TokenAccessEditor({ value, onChange }: { value: McpTokenScope; onChange: (next: McpTokenScope) => void }) {
  const { data: options } = useSWR<ScopeOptions>(
    `${CORE_URL}/api/integrations/mcp/scope-options`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );
  const level = ACCESS_LEVELS.find((l) => l.value === value.maxTier) ?? ACCESS_LEVELS[0];

  return (
    <div className="grid gap-4 w-full">
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">Access</p>
        <Select value={value.maxTier} onValueChange={(v) => onChange({ ...value, maxTier: v as McpTokenTier })}>
          <SelectTrigger size="sm" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCESS_LEVELS.map((l) => (
              <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{level.hint}</p>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">All apps</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Turn off to limit changes to specific apps. Server-wide changes are then refused.
            </p>
          </div>
          <Switch
            checked={value.apps === "*"}
            onCheckedChange={(all) => onChange({ ...value, apps: all ? "*" : [] })}
          />
        </div>
        {value.apps !== "*" && (
          <div className="grid gap-2 rounded-lg bg-muted/30 p-3">
            {options?.apps.length ? (
              options.apps.map((app) => (
                <label key={app.appId} className="flex items-center justify-between gap-4 text-sm">
                  <span className="truncate">{app.name}</span>
                  <Switch
                    checked={(value.apps as string[]).includes(app.appId)}
                    onCheckedChange={(on) => onChange({ ...value, apps: toggle(value.apps, app.appId, on) })}
                  />
                </label>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No installed apps yet.</p>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">All tool areas</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Turn off to expose only some integrations, such as media or Home Assistant.
            </p>
          </div>
          <Switch
            checked={value.domains === "*"}
            onCheckedChange={(all) => onChange({ ...value, domains: all ? "*" : ["core"] })}
          />
        </div>
        {value.domains !== "*" && (
          <div className="grid gap-2 rounded-lg bg-muted/30 p-3">
            {options?.domains.map((domain) => (
              <label key={domain.name} className="flex items-center justify-between gap-4 text-sm">
                <span className="truncate">
                  {domain.name}
                  <span className="text-xs text-muted-foreground ml-2 tabular-nums">{domain.toolCount} tools</span>
                </span>
                <Switch
                  checked={(value.domains as string[]).includes(domain.name)}
                  onCheckedChange={(on) => onChange({ ...value, domains: toggle(value.domains, domain.name, on) })}
                />
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
