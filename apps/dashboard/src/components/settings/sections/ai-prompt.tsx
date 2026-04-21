"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

export function AiPromptSection() {
  const [customPrompt, setCustomPrompt] = useState("");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [defaultOpen, setDefaultOpen] = useState(false);

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings/system-prompt`)
      .then((r) => r.json())
      .then((d: { prompt: string; default: string; isCustom: boolean }) => {
        setDefaultPrompt(d.default);
        setCustomPrompt(d.isCustom ? d.prompt : "");
        setIsCustom(d.isCustom);
      })
      .catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      await fetch(`${CORE_URL}/api/settings/system-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: customPrompt }),
      });
      setIsCustom(!!customPrompt.trim());
      setDirty(false);
      toast.success("Instructions saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true);
    try {
      await fetch(`${CORE_URL}/api/settings/system-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      });
      setCustomPrompt("");
      setIsCustom(false);
      setDirty(false);
      toast.success("Custom instructions cleared");
    } catch {
      toast.error("Failed to clear");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6">
      {/* Explanation */}
      <p className="text-sm text-muted-foreground leading-relaxed">
        The assistant always uses Talome&apos;s built-in prompt for system knowledge. Your custom instructions are added on top — use them to shape personality, set rules, or add context about your setup.
      </p>

      {/* Custom instructions */}
      <SettingsGroup>
        <SettingsRow className="flex-col items-stretch gap-3 py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Your instructions</p>
            {isCustom && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-muted-foreground"
                onClick={() => void clear()}
                disabled={saving}
              >
                Clear
              </Button>
            )}
          </div>
          <textarea
            className="w-full min-h-[160px] max-h-[400px] rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            placeholder={"e.g. Always respond in a concise, friendly tone. My server runs Plex and Sonarr for media. Prefer Docker Compose over individual containers."}
            value={customPrompt}
            onChange={(e) => {
              setCustomPrompt(e.target.value);
              setDirty(true);
            }}
          />
        </SettingsRow>

        {/* Save */}
        <SettingsRow className="justify-between py-3">
          <p className="text-xs text-muted-foreground">
            {isCustom && !dirty
              ? "Custom instructions active"
              : !customPrompt.trim()
                ? "No custom instructions set"
                : "Unsaved changes"}
          </p>
          <Button
            size="sm"
            className="h-7 text-xs px-4"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {/* Default prompt (read-only, collapsible) */}
      <Collapsible open={defaultOpen} onOpenChange={setDefaultOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 w-fit"
          >
            <HugeiconsIcon icon={defaultOpen ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
            View built-in prompt
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-xl border border-border bg-card">
            <pre className="px-4 py-3 text-xs font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-[400px] overflow-y-auto">
              {defaultPrompt}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConfigureWithAI prompt="I'd like to customize the assistant's instructions" />
    </div>
  );
}
