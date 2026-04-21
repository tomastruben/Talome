"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";

interface ToolConfigData {
  disabled: string[];
}

interface ToolMeta {
  name: string;
  tier: string;
  category: string;
}

export function AiBehaviourSection() {
  const [disabled, setDisabled] = useState<string[]>([]);
  const [allTools, setAllTools] = useState<ToolMeta[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings/tool-config`)
      .then((r) => r.json())
      .then((d: ToolConfigData) => {
        setDisabled(d.disabled ?? []);
      })
      .catch(() => {});

    fetch(`${CORE_URL}/api/settings/tool-tiers`)
      .then((r) => r.json())
      .then((d: { tools: ToolMeta[] }) => {
        setAllTools(d.tools ?? []);
      })
      .catch(() => {});
  }, []);

  function toggle(name: string) {
    setDisabled((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]
    );
  }

  async function save() {
    setSaving(true);
    try {
      await fetch(`${CORE_URL}/api/settings/tool-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled }),
      });
      toast.success("Tool settings saved");
    } catch {
      toast.error("Failed to save tool settings");
    }
    setSaving(false);
  }

  function ToolChip({ name }: { name: string }) {
    const isOff = disabled.includes(name);
    return (
      <button
        type="button"
        onClick={() => toggle(name)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-left transition-all duration-150 select-none border",
          isOff
            ? "bg-transparent border-border/30 text-muted-foreground"
            : "bg-muted/50 border-border/70 text-foreground hover:bg-muted/80"
        )}
        aria-pressed={!isOff}
      >
        <span className={cn(
          "text-xs font-mono leading-none transition-all",
          isOff && "line-through decoration-dim-foreground"
        )}>
          {name}
        </span>
      </button>
    );
  }

  function groupByCategory(tier: string) {
    const tools = allTools.filter((t) => t.tier === tier);
    const groups = new Map<string, string[]>();
    for (const t of tools) {
      const list = groups.get(t.category) ?? [];
      list.push(t.name);
      groups.set(t.category, list);
    }
    return groups;
  }

  function TierSection({ tier, label }: { tier: string; label: string }) {
    const groups = groupByCategory(tier);
    const allNames = allTools.filter((t) => t.tier === tier).map((t) => t.name);
    const offCount = allNames.filter((n) => disabled.includes(n)).length;
    if (allNames.length === 0) return null;

    return (
      <SettingsRow className="flex-col items-stretch gap-2.5 py-3.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          {offCount > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">({offCount} off)</span>
          )}
        </div>
        <div className="flex flex-col gap-3">
          {[...groups.entries()].map(([category, names]) => (
            <div key={category} className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{category}</p>
              <div className="flex flex-wrap gap-1.5">
                {names.map((name) => (
                  <ToolChip key={name} name={name} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </SettingsRow>
    );
  }

  return (
    <div className="grid gap-2">
      <SettingsGroup>
        <TierSection tier="destructive" label="Destructive" />
        <div className="h-px bg-border/60 mx-4" />
        <TierSection tier="modify" label="Modify" />
        <div className="h-px bg-border/60 mx-4" />
        <SettingsRow className="justify-end py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs px-3 text-muted-foreground"
            onClick={() => setDisabled([])}
          >
            Enable all
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs px-3"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <p className="text-xs text-muted-foreground px-1">
        Tap to toggle. Disabled tools are removed from the AI&apos;s available actions.
      </p>
    </div>
  );
}
