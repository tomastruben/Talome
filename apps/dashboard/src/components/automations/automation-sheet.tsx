"use client";

import { useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  HugeiconsIcon,
  Add01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
  Package01Icon,
  HardDriveIcon,
  DownloadSquare01Icon,
  Clock01Icon,
  Globe02Icon,
  Notification01Icon,
  BrainIcon,
  ArrowDown01Icon,
  FilterIcon,
  Settings01Icon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import useSWR from "swr";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TriggerConfig {
  type: string;
  containerId?: string;
  mountPath?: string;
  threshold?: number;
  appId?: string;
  cron?: string;
  webhookSecret?: string;
}

// v2 step types
export type StepConfig =
  | { _id: string; type: "notify"; level: string; title: string; body?: string }
  | { _id: string; type: "tool_action"; toolName: string; args?: Record<string, unknown>; approvalPolicy?: "auto" | "require_approval" }
  | { _id: string; type: "ai_prompt"; promptTemplate: string; allowedTools: string[]; approvalPolicy?: "auto" | "require_approval"; outputKey?: string }
  | { _id: string; type: "condition"; field: string; operator: "eq" | "gt" | "lt" | "contains"; value: string; onFail?: "stop" | "continue" };

export interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  actions: string;
  steps?: string | null;
  workflowVersion?: number;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
}

interface StepRun {
  id: string;
  stepId: string;
  stepType: string;
  startedAt: string;
  durationMs: number | null;
  success: boolean;
  output: string | null;
  error: string | null;
  blocked: boolean;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  triggeredAt: string;
  success: boolean;
  error: string | null;
  actionsRun: number;
  resultSummary?: string | null;
  stepRuns?: StepRun[];
}

// ── Constants ────────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  { value: "container_stopped",  label: "Container stopped",   icon: Package01Icon,        dotColor: "sky"   as const },
  { value: "disk_usage_exceeds", label: "Disk usage exceeds",  icon: HardDriveIcon,        dotColor: "amber" as const },
  { value: "app_installed",      label: "App installed",       icon: DownloadSquare01Icon, dotColor: "sky"   as const },
  { value: "schedule",           label: "Schedule (cron)",     icon: Clock01Icon,          dotColor: "muted" as const },
  { value: "webhook",            label: "Webhook",             icon: Globe02Icon,          dotColor: "sky"   as const },
];

export const STEP_TYPES = [
  { value: "notify",       label: "Send notification",  icon: Notification01Icon,    dotColor: "blue"  as const, tier: "modify"  as const },
  { value: "ai_prompt",    label: "AI Prompt",          icon: BrainIcon,             dotColor: "sky"   as const, tier: "modify"  as const },
  { value: "tool_action",  label: "Tool action",        icon: Settings01Icon,        dotColor: "amber" as const, tier: "modify"  as const },
  { value: "condition",    label: "Condition",          icon: FilterIcon,            dotColor: "muted" as const, tier: "read"    as const },
];

// Fallback tools shown while the dynamic list loads
const FALLBACK_SAFE_TOOLS: Array<{ name: string; tier: "read" | "modify" }> = [
  { name: "list_containers",       tier: "read"   },
  { name: "get_container_logs",    tier: "read"   },
  { name: "check_service_health",  tier: "read"   },
  { name: "get_system_stats",      tier: "read"   },
  { name: "get_system_health",     tier: "read"   },
  { name: "restart_container",     tier: "modify" },
];

function newStep(type = "notify"): StepConfig {
  const _id = Math.random().toString(36).slice(2);
  switch (type) {
    case "notify":      return { _id, type: "notify",      level: "info", title: "" };
    case "ai_prompt":   return { _id, type: "ai_prompt",   promptTemplate: "", allowedTools: [] };
    case "tool_action": return { _id, type: "tool_action", toolName: "restart_container" };
    case "condition":   return { _id, type: "condition",   field: "containerName", operator: "eq", value: "" };
    default:            return { _id, type: "notify",      level: "info", title: "" };
  }
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ── Tier badge ───────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: "read" | "modify" | "destructive" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-xs py-0 px-1.5 font-medium border",
        tier === "read"        && "text-status-healthy  border-status-healthy/30  bg-status-healthy/5",
        tier === "modify"      && "text-status-warning  border-status-warning/30  bg-status-warning/5",
        tier === "destructive" && "text-status-critical    border-status-critical/30    bg-status-critical/5",
      )}
    >
      {tier === "read" ? "Read" : tier === "modify" ? "Modify" : "Destructive"}
    </Badge>
  );
}

// ── TriggerCard ───────────────────────────────────────────────────────────────

function TriggerCard({
  config,
  onChange,
}: {
  config: TriggerConfig;
  onChange: (c: TriggerConfig) => void;
}) {
  const [open, setOpen] = useState(true);
  const info = TRIGGER_TYPES.find((t) => t.value === config.type);

  const { data: containersData } = useSWR<Array<{ id: string; name: string; status: string }>>(
    config.type === "container_stopped" ? `${CORE_URL}/api/containers` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-border/60 bg-card/40 overflow-hidden">
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors">
          <div className="w-1.5 h-1.5 rounded-full bg-status-info shrink-0" />
          <span className="text-sm font-medium flex-1">
            {info?.label ?? config.type}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={14}
            className={`text-dim-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/40 px-4 py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Trigger type</Label>
              <Select value={config.type} onValueChange={(v) => onChange({ type: v })}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRIGGER_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {config.type === "container_stopped" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Container <span className="opacity-50">(optional)</span></Label>
                <Select
                  value={config.containerId ?? "__any__"}
                  onValueChange={(v) => onChange({ ...config, containerId: v === "__any__" ? undefined : v })}
                >
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Any container" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__any__">Any container</SelectItem>
                    {(containersData ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {config.type === "app_installed" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">App ID <span className="opacity-50">(optional)</span></Label>
                <Input
                  className="h-8 text-sm"
                  placeholder="Leave blank to match any"
                  value={config.appId ?? ""}
                  onChange={(e) => onChange({ ...config, appId: e.target.value || undefined })}
                />
              </div>
            )}

            {config.type === "disk_usage_exceeds" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Threshold (%)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number" min={1} max={99}
                    className="h-8 w-24 text-sm"
                    value={config.threshold ?? 80}
                    onChange={(e) => onChange({ ...config, threshold: Number(e.target.value) })}
                  />
                  <span className="text-sm text-muted-foreground">% disk usage</span>
                </div>
              </div>
            )}

            {config.type === "schedule" && (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Cron expression</Label>
                  <Input
                    className="h-8 font-mono text-sm" placeholder="0 * * * *"
                    value={config.cron ?? ""}
                    onChange={(e) => onChange({ ...config, cron: e.target.value })}
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: "Every hour", cron: "0 * * * *" },
                    { label: "Every 6h", cron: "0 */6 * * *" },
                    { label: "Daily 2am", cron: "0 2 * * *" },
                    { label: "Weekly Sun", cron: "0 2 * * 0" },
                    { label: "Monthly 1st", cron: "0 2 1 * *" },
                  ].map((preset) => (
                    <button
                      key={preset.cron}
                      type="button"
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full border transition-colors",
                        config.cron === preset.cron
                          ? "bg-primary/10 border-primary/30 text-primary"
                          : "border-border/60 text-muted-foreground hover:bg-muted/30"
                      )}
                      onClick={() => onChange({ ...config, cron: preset.cron })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {config.type === "webhook" && (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Webhook secret <span className="opacity-50">(optional)</span></Label>
                  <Input
                    className="h-8 font-mono text-sm" placeholder="HMAC secret for signature verification"
                    value={config.webhookSecret ?? ""}
                    onChange={(e) => onChange({ ...config, webhookSecret: e.target.value || undefined })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  After saving, send POST requests to <span className="font-mono">/api/webhooks/{"<id>"}</span> to trigger this automation.
                </p>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── StepCard ─────────────────────────────────────────────────────────────────

function useAutomationSafeTools() {
  const { data } = useSWR<{ tools: Array<{ name: string; tier: "read" | "modify" }> }>(
    `${CORE_URL}/api/automations/tools`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );
  return data?.tools ?? FALLBACK_SAFE_TOOLS;
}

function StepCard({
  config,
  index,
  onChange,
  onRemove,
  dragHandleProps,
}: {
  config: StepConfig;
  index: number;
  onChange: (c: StepConfig) => void;
  onRemove: () => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(true);
  const info = STEP_TYPES.find((s) => s.value === config.type);
  const automationSafeTools = useAutomationSafeTools();

  const { data: containersData } = useSWR<Array<{ id: string; name: string; status: string }>>(
    config.type === "tool_action" && config.toolName === "restart_container"
      ? `${CORE_URL}/api/containers`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  function changeType(newType: string) {
    onChange(newStep(newType));
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl border border-border/60 bg-card/40 overflow-hidden">
        <CollapsibleTrigger asChild>
          <div className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/20 transition-colors cursor-pointer">
            <span
              {...dragHandleProps}
              className="cursor-grab active:cursor-grabbing text-dim-foreground hover:text-muted-foreground transition-colors shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <HugeiconsIcon icon={DragDropVerticalIcon} size={14} />
            </span>

            <div className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              config.type === "notify"      && "bg-status-info",
              config.type === "ai_prompt"   && "bg-status-info",
              config.type === "tool_action" && "bg-status-warning",
              config.type === "condition"   && "bg-muted-foreground/40",
            )} />

            <span className="text-sm font-medium flex-1 min-w-0 truncate">
              {info?.label ?? config.type}
              {config.type === "ai_prompt" && config.promptTemplate && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  — {config.promptTemplate.slice(0, 40)}
                </span>
              )}
              {config.type === "tool_action" && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {config.toolName}
                </span>
              )}
            </span>

            <span className="text-xs text-muted-foreground tabular-nums shrink-0">#{index + 1}</span>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="p-2 rounded text-dim-foreground hover:text-destructive transition-colors shrink-0"
            >
              <HugeiconsIcon icon={Delete02Icon} size={12} />
            </button>

            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              className={`text-dim-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
            />
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border/40 px-4 py-3 space-y-3">
            {/* Step type selector */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Step type</Label>
              <Select value={config.type} onValueChange={changeType}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STEP_TYPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      <span className="flex items-center gap-2">
                        {s.label}
                        <span className={cn(
                          "text-xs px-1 rounded font-medium",
                          s.tier === "read"   && "bg-status-healthy/10 text-status-healthy",
                          s.tier === "modify" && "bg-status-warning/10 text-status-warning",
                        )}>
                          {s.tier}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Notify fields */}
            {config.type === "notify" && (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Level</Label>
                  <Select value={config.level} onValueChange={(v) => onChange({ ...config, level: v })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Title</Label>
                  <Input
                    className="h-8 text-sm" placeholder="Notification title"
                    value={config.title}
                    onChange={(e) => onChange({ ...config, title: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Body <span className="opacity-50">(optional)</span></Label>
                  <Input
                    className="h-8 text-sm" placeholder="Additional details — use {{field}} for trigger data"
                    value={config.body ?? ""}
                    onChange={(e) => onChange({ ...config, body: e.target.value || undefined })}
                  />
                </div>
              </div>
            )}

            {/* AI Prompt fields */}
            {config.type === "ai_prompt" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Prompt
                    <span className="ml-1 opacity-50">— use {"{{field}}"} for trigger data</span>
                  </Label>
                  <textarea
                    className="flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                    placeholder="e.g. Check why {{containerName}} stopped and send a diagnosis notification"
                    value={config.promptTemplate}
                    onChange={(e) => onChange({ ...config, promptTemplate: e.target.value })}
                    rows={3}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Allowed tools</Label>
                  <div className="rounded-lg border border-border/60 p-2 space-y-1 max-h-48 overflow-y-auto">
                    {automationSafeTools.map((t) => (
                      <label
                        key={t.name}
                        className="flex items-center gap-2.5 px-1 py-1 rounded hover:bg-muted/30 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 rounded"
                          checked={config.allowedTools.includes(t.name)}
                          onChange={(e) => {
                            const tools = e.target.checked
                              ? [...config.allowedTools, t.name]
                              : config.allowedTools.filter((x) => x !== t.name);
                            onChange({ ...config, allowedTools: tools });
                          }}
                        />
                        <span className="text-xs flex-1 font-mono truncate">{t.name}</span>
                        <TierBadge tier={t.tier} />
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Output key <span className="opacity-50">(optional)</span></Label>
                  <Input
                    className="h-8 font-mono text-sm" placeholder="e.g. diagnosis"
                    value={config.outputKey ?? ""}
                    onChange={(e) => onChange({ ...config, outputKey: e.target.value || undefined })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Store the AI output as {"{{outputKey}}"} for use in later steps
                  </p>
                </div>

                <div className="rounded-lg border border-border/60 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium">Require approval</p>
                      <p className="text-xs text-muted-foreground">
                        When on, this step pauses for confirmation before running.
                      </p>
                    </div>
                    <Switch
                      checked={config.approvalPolicy === "require_approval"}
                      onCheckedChange={(v) => onChange({ ...config, approvalPolicy: v ? "require_approval" : "auto" })}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Tool action fields */}
            {config.type === "tool_action" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Tool</Label>
                  <Select
                    value={config.toolName}
                    onValueChange={(v) => onChange({ ...config, toolName: v })}
                  >
                    <SelectTrigger className="h-8 text-sm font-mono truncate"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {automationSafeTools.map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          <span className="flex items-center gap-2 font-mono text-xs min-w-0">
                            <span className="truncate">{t.name}</span>
                            <span className={cn(
                              "text-xs px-1 rounded font-sans font-medium",
                              t.tier === "read"   && "bg-status-healthy/10 text-status-healthy",
                              t.tier === "modify" && "bg-status-warning/10 text-status-warning",
                            )}>{t.tier}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Container picker for restart_container */}
                {config.toolName === "restart_container" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Container</Label>
                    <Select
                      value={String(config.args?.containerId ?? "")}
                      onValueChange={(v) => onChange({ ...config, args: { containerId: v } })}
                    >
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select a container" /></SelectTrigger>
                      <SelectContent>
                        {(containersData ?? []).map((c) => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="rounded-lg border border-border/60 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium">Require approval</p>
                      <p className="text-xs text-muted-foreground">
                        When on, pauses for confirmation before running this tool.
                      </p>
                    </div>
                    <Switch
                      checked={(config.approvalPolicy ?? "require_approval") === "require_approval"}
                      onCheckedChange={(v) => onChange({ ...config, approvalPolicy: v ? "require_approval" : "auto" })}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Condition fields */}
            {config.type === "condition" && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Field</Label>
                    <Input
                      className="h-8 font-mono text-sm" placeholder="containerName"
                      value={config.field}
                      onChange={(e) => onChange({ ...config, field: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Operator</Label>
                    <Select value={config.operator} onValueChange={(v) => onChange({ ...config, operator: v as StepConfig extends { type: "condition" } ? StepConfig["operator"] : never })}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="eq">eq (=)</SelectItem>
                        <SelectItem value="gt">gt (&gt;)</SelectItem>
                        <SelectItem value="lt">lt (&lt;)</SelectItem>
                        <SelectItem value="contains">contains</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Value</Label>
                    <Input
                      className="h-8 text-sm" placeholder="sonarr"
                      value={config.value}
                      onChange={(e) => onChange({ ...config, value: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">If condition fails</Label>
                  <Select value={config.onFail ?? "stop"} onValueChange={(v) => onChange({ ...config, onFail: v as "stop" | "continue" })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stop">Stop automation</SelectItem>
                      <SelectItem value="continue">Continue to next step</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ── Sortable step wrapper ────────────────────────────────────────────────────

function SortableStepCard({
  step,
  index,
  onChange,
  onRemove,
}: {
  step: StepConfig;
  index: number;
  onChange: (c: StepConfig) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step._id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
    >
      <StepCard
        config={step}
        index={index}
        onChange={onChange}
        onRemove={onRemove}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ── SimulatePanel ────────────────────────────────────────────────────────────

function SimulatePanel({ automationId }: { automationId: string }) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Array<{
    id: string;
    type: string;
    label: string;
    requiresApproval: boolean;
    allowedTools?: string[];
  }> | null>(null);
  const [error, setError] = useState("");

  async function runSimulate() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${CORE_URL}/api/automations/${automationId}/simulate`, { method: "POST" });
      const data = await res.json() as { preview?: typeof preview; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Simulation failed");
      setPreview(data.preview ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Preview what this automation will do — see which steps require approval before enabling.
      </p>
      <Button size="sm" variant="outline" onClick={runSimulate} disabled={loading}>
        {loading ? "Simulating…" : "Run simulation"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {preview && (
        <div className="rounded-xl border overflow-hidden divide-y">
          {preview.map((step, i) => (
            <div key={step.id} className="flex items-start gap-3 px-4 py-3">
              <span className="text-xs text-muted-foreground tabular-nums pt-0.5 w-5 text-right">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{step.label}</p>
                {step.allowedTools && step.allowedTools.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                    Tools: {step.allowedTools.join(", ")}
                  </p>
                )}
              </div>
              {step.requiresApproval ? (
                <Badge variant="outline" className="text-xs text-status-warning border-status-warning/30 bg-status-warning/5 shrink-0">
                  Needs approval
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-status-healthy border-status-healthy/30 bg-status-healthy/5 shrink-0">
                  Auto
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Run History ───────────────────────────────────────────────────────────────

const CLAMP_THRESHOLD = 120; // chars — below this, don't bother clamping

function ExpandableText({
  children,
  className,
}: {
  children: string;
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsClamp = children.length > CLAMP_THRESHOLD;

  return (
    <div>
      <Streamdown className={cn(className, !expanded && needsClamp && "line-clamp-3")}>
        {children}
      </Streamdown>
      {needsClamp && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted-foreground/60 hover:text-muted-foreground mt-0.5 transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function RunHistory({ automationId }: { automationId: string }) {
  const { data, isLoading } = useSWR<{ runs: AutomationRun[] }>(
    `${CORE_URL}/api/automations/${automationId}/runs`,
    fetcher,
    { refreshInterval: 10_000 }
  );

  const runs = data?.runs ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2 p-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
        <p className="text-sm text-muted-foreground">No runs yet</p>
        <p className="text-xs text-muted-foreground">Use the run button to trigger manually</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <div key={run.id} className="rounded-xl border overflow-hidden">
          {/* Run header */}
          <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/20 border-b">
            <Pill variant="secondary" className="text-xs gap-1.5 py-0.5 px-2">
              <PillIndicator variant={run.success ? "success" : "error"} />
              {run.success ? "Success" : "Failed"}
            </Pill>
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title={new Date(run.triggeredAt).toLocaleString()}
            >
              {relativeTime(run.triggeredAt)}
            </span>
            {run.error && (
              <span className="text-xs text-destructive/70 break-words flex-1">
                {run.error}
              </span>
            )}
          </div>

          {/* Per-step run detail */}
          {run.stepRuns && run.stepRuns.length > 0 ? (
            <div className="divide-y">
              {run.stepRuns.map((sr, i) => (
                <div key={sr.id} className="flex items-start gap-3 px-4 py-2">
                  <span className="text-xs text-muted-foreground tabular-nums pt-0.5 w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-muted-foreground truncate">{sr.stepType}</span>
                      {sr.blocked && (
                        <Badge variant="outline" className="text-xs text-status-warning border-status-warning/30 bg-status-warning/5">
                          Blocked
                        </Badge>
                      )}
                      {!sr.blocked && (
                        <Badge variant="outline" className={cn(
                          "text-xs",
                          sr.success ? "text-status-healthy border-status-healthy/30 bg-status-healthy/5" : "text-status-critical border-status-critical/30 bg-status-critical/5",
                        )}>
                          {sr.success ? "✓" : "✗"}
                        </Badge>
                      )}
                      {sr.durationMs != null && (
                        <span className="text-xs text-muted-foreground">{sr.durationMs}ms</span>
                      )}
                    </div>
                    {sr.output && (
                      <ExpandableText className="text-xs text-muted-foreground mt-0.5 break-words leading-relaxed [&_strong]:text-foreground [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.7rem] [&_p+p]:mt-1 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mt-0.5">
                        {sr.output}
                      </ExpandableText>
                    )}
                    {sr.error && (
                      <ExpandableText className="text-xs text-destructive/70 mt-0.5 break-words leading-relaxed [&_strong]:text-destructive [&_code]:bg-destructive/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.7rem] [&_p+p]:mt-1">
                        {sr.error}
                      </ExpandableText>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            run.resultSummary && (
              <div className="px-4 py-2">
                <ExpandableText className="text-xs text-muted-foreground break-words leading-relaxed [&_strong]:text-foreground [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.7rem] [&_p+p]:mt-1">
                  {(() => {
                    try {
                      const parsed = JSON.parse(run.resultSummary) as Array<{ output?: string; summary?: string }>;
                      return parsed.map((x) => x.output ?? x.summary).filter(Boolean).join("\n\n");
                    } catch { return run.resultSummary; }
                  })()}
                </ExpandableText>
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main Sheet ────────────────────────────────────────────────────────────────

interface AutomationSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  automation?: AutomationRow | null;
  onSaved: () => void;
}

function migrateActionsToSteps(actionsJson: string): StepConfig[] {
  try {
    const actions = JSON.parse(actionsJson) as Array<{
      type: string;
      containerId?: string;
      level?: string;
      title?: string;
      body?: string;
      command?: string;
      prompt?: string;
      approved?: boolean;
    }>;
    return actions.map((a) => {
      const _id = Math.random().toString(36).slice(2);
      if (a.type === "restart_container")
        return { _id, type: "tool_action" as const, toolName: "restart_container", args: { containerId: a.containerId ?? "" }, approvalPolicy: "auto" as const };
      if (a.type === "send_notification")
        return { _id, type: "notify" as const, level: a.level ?? "info", title: a.title ?? "", body: a.body };
      if (a.type === "run_shell")
        return { _id, type: "tool_action" as const, toolName: "run_shell", args: { command: a.command ?? "" }, approvalPolicy: a.approved ? "auto" as const : "require_approval" as const };
      if (a.type === "ask_ai")
        return { _id, type: "ai_prompt" as const, promptTemplate: a.prompt ?? "", allowedTools: [], approvalPolicy: a.approved ? "auto" as const : "require_approval" as const };
      return { _id, type: "notify" as const, level: "info", title: a.type };
    });
  } catch { return [newStep("notify")]; }
}

export function AutomationSheet({ open, onOpenChange, automation, onSaved }: AutomationSheetProps) {
  const isEdit = !!automation;
  const isMobile = useIsMobile();

  const [name, setName] = useState(automation?.name ?? "");
  const [trigger, setTrigger] = useState<TriggerConfig>(() => {
    try {
      if (automation) return JSON.parse(automation.trigger) as TriggerConfig;
      return { type: "container_stopped" };
    } catch { return { type: "container_stopped" }; }
  });

  const [steps, setSteps] = useState<StepConfig[]>(() => {
    if (!automation) return [newStep("notify")];
    // v2 steps
    if (automation.workflowVersion === 2 && automation.steps) {
      try {
        const parsed = JSON.parse(automation.steps) as Array<Record<string, unknown>>;
        return parsed.map((s) => ({ ...s, _id: s._id ?? Math.random().toString(36).slice(2) } as StepConfig));
      } catch { /* fall through to v1 */ }
    }
    // v1 actions → migrate to steps UI
    return migrateActionsToSteps(automation.actions);
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("builder");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = steps.findIndex((s) => s._id === active.id);
    const newIdx = steps.findIndex((s) => s._id === over.id);
    if (oldIdx !== -1 && newIdx !== -1) setSteps(arrayMove(steps, oldIdx, newIdx));
  }

  function updateStep(idx: number, updated: StepConfig) {
    setSteps((prev) => prev.map((s, i) => i === idx ? updated : s));
  }

  function removeStep(idx: number) {
    if (steps.length === 1) return;
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!trigger.type) { setError("Trigger type is required"); return; }
    setSaving(true);
    setError("");

    // Strip client-only _id from steps; ensure each has a real id
    const cleanSteps = steps.map(({ _id, ...rest }) => ({
      id: _id,
      ...rest,
    }));

    try {
      const url = isEdit
        ? `${CORE_URL}/api/automations/${automation!.id}`
        : `${CORE_URL}/api/automations`;

      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), trigger, steps: cleanSteps }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        throw new Error(d.error ?? "Unknown error");
      }
      onSaved();
      onOpenChange(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "flex flex-col p-0 gap-0",
          isMobile ? "h-[95svh] rounded-t-xl" : "sm:max-w-lg"
        )}
      >
        <SheetHeader className="px-4 sm:px-6 py-4 border-b border-border/60 shrink-0">
          <SheetTitle className="text-base font-medium">
            {isEdit ? "Edit Automation" : "New Automation"}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {isEdit ? "Edit automation trigger, steps, and settings" : "Create a new automation with a trigger and steps"}
          </SheetDescription>
        </SheetHeader>

        {isEdit && (
          <div className="px-4 sm:px-6 pt-3 shrink-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="builder" className="text-xs">Builder</TabsTrigger>
                <TabsTrigger value="simulate" className="text-xs">Simulate</TabsTrigger>
                <TabsTrigger value="history" className="text-xs">Run History</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 sm:px-6 py-4 space-y-4">
            {(activeTab === "builder" || !isEdit) && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Name</Label>
                  <Input
                    className="h-9" placeholder="e.g. Restart on crash"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest pt-1">
                  Trigger
                </p>

                <TriggerCard config={trigger} onChange={setTrigger} />

                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-border/40" />
                  <span className="text-xs text-muted-foreground uppercase tracking-widest">Then</span>
                  <div className="flex-1 h-px bg-border/40" />
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest -mt-2">
                  Steps
                </p>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={steps.map((s) => s._id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {steps.map((step, idx) => (
                        <SortableStepCard
                          key={step._id}
                          step={step}
                          index={idx}
                          onChange={(updated) => updateStep(idx, updated)}
                          onRemove={() => removeStep(idx)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                {/* Add step buttons */}
                <div className="grid grid-cols-2 gap-1.5">
                  {STEP_TYPES.map((t) => (
                    <Button
                      key={t.value}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 border-dashed text-muted-foreground text-xs gap-1.5 justify-start"
                      onClick={() => setSteps((prev) => [...prev, newStep(t.value)])}
                    >
                      <HugeiconsIcon icon={t.icon} size={12} />
                      {t.label}
                    </Button>
                  ))}
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}
              </>
            )}

            {activeTab === "simulate" && isEdit && (
              <SimulatePanel automationId={automation!.id} />
            )}

            {activeTab === "history" && isEdit && (
              <RunHistory automationId={automation!.id} />
            )}
          </div>
        </ScrollArea>

        {(activeTab === "builder" || !isEdit) && (
          <SheetFooter className="px-4 sm:px-6 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] border-t border-border/60 shrink-0 !flex-row items-center gap-3">
            {isEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive mr-auto"
                onClick={async () => {
                  try {
                    const res = await fetch(`${CORE_URL}/api/automations/${automation!.id}`, { method: "DELETE" });
                    if (!res.ok) {
                      const d = await res.json().catch(() => ({})) as { error?: string };
                      throw new Error(d.error ?? "Failed to delete automation");
                    }
                    onSaved();
                    onOpenChange(false);
                  } catch (err) {
                    toast.error("Failed to delete automation", {
                      description: err instanceof Error ? err.message : undefined,
                    });
                  }
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={13} />
                Delete
              </Button>
            )}
            {!isEdit && <div className="flex-1" />}
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
