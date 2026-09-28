"use client";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  HugeiconsIcon,
  LockedIcon,
  Edit02Icon,
  AlertCircleIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import {
  TIER_OPTIONS,
  countGrantedTools,
  humanToolName,
  type GrantCatalog,
  type TokenScopes,
  type ToolTier,
} from "@/components/trust/format";

const TIER_ICONS: Record<ToolTier, IconSvgElement> = {
  read: LockedIcon,
  modify: Edit02Icon,
  destructive: AlertCircleIcon,
};

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{children}</p>;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-150 ease-out",
        active
          ? "bg-foreground/10 text-foreground ring-1 ring-foreground/20"
          : "bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function GrantEditor({
  catalog,
  value,
  onChange,
}: {
  catalog: GrantCatalog | undefined;
  value: TokenScopes;
  onChange: (next: TokenScopes) => void;
}) {
  const domains = catalog?.domains ?? [];
  const apps = catalog?.apps ?? [];
  const totalTools = domains.reduce((n, d) => n + d.tools.length, 0);
  const granted = catalog ? countGrantedTools(catalog, value) : null;
  const allDomains = value.domains === "all";
  const allApps = value.apps === "all";

  return (
    <div className="grid gap-6">
      {/* Access level */}
      <div className="grid gap-2" role="radiogroup" aria-label="Access level">
        <FieldLabel>Access level</FieldLabel>
        {TIER_OPTIONS.map((opt) => {
          const active = value.maxTier === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange({ ...value, maxTier: opt.value })}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3.5 py-3 text-left transition-colors duration-150 ease-out",
                active ? "bg-foreground/10 ring-1 ring-foreground/20" : "bg-muted/40 hover:bg-muted/60",
              )}
            >
              <div
                className={cn(
                  "size-7 rounded-md flex items-center justify-center shrink-0 mt-0.5",
                  active ? "bg-foreground/10 text-foreground" : "bg-muted/50 text-muted-foreground",
                  active && opt.value === "destructive" && "text-status-warning",
                )}
              >
                <HugeiconsIcon icon={TIER_ICONS[opt.value]} size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={cn("text-sm font-medium", active ? "text-foreground" : "text-muted-foreground")}>
                  {opt.label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{opt.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Tool groups */}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Tool groups</FieldLabel>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            All
            <Switch
              checked={allDomains}
              onCheckedChange={(checked) => onChange({ ...value, domains: checked ? "all" : [] })}
              aria-label="All tool groups"
            />
          </label>
        </div>
        {!allDomains && (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <Chip
                key={d.name}
                active={value.domains !== "all" && value.domains.includes(d.name)}
                onClick={() =>
                  onChange({ ...value, domains: toggle(value.domains === "all" ? [] : value.domains, d.name) })
                }
              >
                {humanToolName(d.name)}
                <span className="text-dim-foreground tabular-nums">{d.tools.length}</span>
              </Chip>
            ))}
            {domains.length === 0 && <p className="text-xs text-muted-foreground">Loading tool groups…</p>}
          </div>
        )}
      </div>

      {/* Apps */}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Apps</FieldLabel>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            All apps
            <Switch
              checked={allApps}
              onCheckedChange={(checked) => onChange({ ...value, apps: checked ? "all" : [] })}
              aria-label="All apps"
            />
          </label>
        </div>
        {!allApps && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {apps.map((appId) => (
                <Chip
                  key={appId}
                  active={value.apps !== "all" && value.apps.includes(appId)}
                  onClick={() => onChange({ ...value, apps: toggle(value.apps === "all" ? [] : value.apps, appId) })}
                >
                  {appId}
                </Chip>
              ))}
              {apps.length === 0 && <p className="text-xs text-muted-foreground">No apps installed yet.</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              Changes are only allowed on these apps and their containers. Actions whose target can&apos;t be
              determined are refused.
            </p>
          </>
        )}
      </div>

      {granted !== null && (
        <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {granted} of {totalTools} tools available to this token
        </p>
      )}
    </div>
  );
}
