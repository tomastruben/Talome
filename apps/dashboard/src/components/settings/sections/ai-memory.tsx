"use client";

import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, Delete01Icon, ArrowDown01Icon, ArrowRight01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, relativeTime, settingsRequest } from "@/components/settings/settings-primitives";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

interface Memory {
  id: number;
  type: string;
  content: string;
  confidence: number;
  createdAt: string;
}

const TYPES = ["preference", "fact", "context", "correction"] as const;

const TYPE_LABELS: Record<string, string> = {
  preference: "Preferences",
  fact: "Facts",
  context: "Context",
  correction: "Corrections",
};

export function AiMemorySection() {
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const confirm = useConfirm();
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set());

  const { data: memoriesList, mutate: mutateMemories } = useSWR<Memory[]>(
    `${CORE_URL}/api/memories`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    fetch(`${CORE_URL}/api/memories/enabled`)
      .then((r) => r.json())
      .then((d: { enabled: boolean }) => setMemoryEnabled(d.enabled))
      .catch(() => {});
  }, []);

  const count = memoriesList?.length ?? 0;

  const grouped = useMemo(() => {
    if (!memoriesList) return {};
    const map: Record<string, Memory[]> = {};
    for (const m of memoriesList) {
      (map[m.type] ??= []).push(m);
    }
    return map;
  }, [memoriesList]);

  function toggleType(type: string) {
    setOpenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <div className="grid gap-6">
      {/* Toggle */}
      <SettingsGroup>
        <SettingsRow>
          <div className="flex flex-col flex-1 min-w-0">
            <Label className="text-sm font-normal">Enable memory</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              The assistant learns facts from conversations and remembers them across sessions.
            </p>
          </div>
          <Switch
            checked={memoryEnabled}
            onCheckedChange={async (checked) => {
              setMemoryEnabled(checked);
              try {
                await settingsRequest(`${CORE_URL}/api/memories/enabled`, { method: "POST", body: { enabled: checked } }, "Couldn't change memory. Try again.");
              } catch (err) {
                // The switch reverts: it only shows what the server saved.
                setMemoryEnabled(!checked);
                toast.error(err instanceof Error ? err.message : "Couldn't change memory. Try again.");
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Memories list */}
      {count > 0 && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground tabular-nums">
              {count} {count === 1 ? "memory" : "memories"}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-status-critical"
              onClick={async () => {
                const { confirmed } = await confirm({
                  tier: "destructive",
                  title: `Delete all ${count} ${count === 1 ? "memory" : "memories"}?`,
                  consequence: "The Assistant forgets your preferences, facts and corrections, and starts learning them again.",
                  recovery: "This can't be undone.",
                  irreversible: true,
                  confirmLabel: "Delete all memories",
                  busyLabel: "Deleting memories…",
                  run: () => settingsRequest(`${CORE_URL}/api/memories?confirm=true`, { method: "DELETE" }, "Couldn't delete the memories. Try again."),
                  receipt: "Deleted all memories",
                });
                if (confirmed) mutateMemories();
              }}
            >
              Delete all…
            </Button>
          </div>

          {TYPES.map((type) => {
            const group = grouped[type];
            if (!group || group.length === 0) return null;
            const isOpen = openTypes.has(type);

            return (
              <section key={type} className="space-y-1">
                {/* Section header — full-width tap target */}
                <button
                  type="button"
                  onClick={() => toggleType(type)}
                  className="flex items-center gap-2 w-full py-1.5 text-xs font-medium text-muted-foreground active:text-foreground transition-colors"
                >
                  <HugeiconsIcon
                    icon={isOpen ? ArrowDown01Icon : ArrowRight01Icon}
                    size={14}
                    className="shrink-0"
                  />
                  <span>{TYPE_LABELS[type]}</span>
                  <span className="font-normal tabular-nums">{group.length}</span>
                </button>

                {/* Memory rows — lightweight, no card wrapper */}
                {isOpen && (
                  <div className="divide-y divide-border/50">
                    {group.map((memory) => (
                      <div
                        key={memory.id}
                        className="flex gap-2 py-3 group/row"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm leading-relaxed break-words">
                            {memory.content}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1.5">
                            {relativeTime(memory.createdAt)}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-status-critical hover:bg-muted/50 transition-colors duration-150 shrink-0 self-start outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100 pointer-coarse:opacity-100"
                          onClick={async () => {
                            try {
                              await settingsRequest(`${CORE_URL}/api/memories/${memory.id}`, { method: "DELETE" }, "Couldn't forget this memory. Try again.");
                              toast.success("Forgot the memory");
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : "Couldn't forget this memory. Try again.");
                            } finally {
                              mutateMemories();
                            }
                          }}
                          title="Forget this memory"
                          aria-label="Forget this memory"
                        >
                          <HugeiconsIcon icon={Delete01Icon} size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {count === 0 && memoriesList !== undefined && (
        <p className="text-sm text-muted-foreground">
          No memories yet. The assistant will start remembering as you chat.
        </p>
      )}

      <ConfigureWithAI prompt="What do you remember about my setup and preferences?" />
    </div>
  );
}
