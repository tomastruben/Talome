"use client";

import { useFeatureStack, type DepStatusResult } from "@/hooks/use-feature-stacks";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, Tick01Icon, Settings01Icon, Download01Icon, AiChat02Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter } from "next/navigation";

interface StackSetupProps {
  stackId: string;
  onSetupWithAI?: (prompt: string) => void;
}

export function StackSetup({ stackId, onSetupWithAI }: StackSetupProps) {
  const { stack, isLoading } = useFeatureStack(stackId);
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-64" />
      </div>
    );
  }

  if (!stack) return null;

  const required = stack.deps.filter(d => d.required);
  const optional = stack.deps.filter(d => !d.required);
  const total = required.length;
  const done = required.filter(d => d.status === "configured").length;

  // Build AI prompt with missing deps
  const missing = stack.deps.filter(d => d.status !== "configured");
  const installed = stack.deps.filter(d => d.status === "configured").map(d => d.label);
  const missingLabels = missing.map(d => d.label);
  const aiPrompt = installed.length > 0
    ? `Help me set up my ${stack.name.toLowerCase()} stack. I currently have ${installed.join(", ")} configured but I still need ${missingLabels.join(", ")}. Can you install and configure the missing services?`
    : `Help me set up a ${stack.name.toLowerCase()} stack from scratch. I need: ${stack.deps.map(d => d.label).join(", ")}.`;

  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 max-w-lg mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-lg font-medium mb-2">Set up {stack.name}</h2>
        <p className="text-sm text-muted-foreground">{stack.description}</p>
        {total > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            {done} of {total} required services ready
          </p>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 bg-muted/30 rounded-full mb-8 overflow-hidden">
        <div
          className="h-full bg-status-healthy rounded-full transition-all duration-500"
          style={{ width: `${Math.round(stack.readiness * 100)}%` }}
        />
      </div>

      {/* Dependency list */}
      <div className="w-full space-y-1.5 mb-8">
        {[...required, ...optional].map((dep) => (
          <DepRow key={dep.appId} dep={dep} onNavigate={(path) => router.push(path)} />
        ))}
      </div>

      {/* Primary action: Set up with AI */}
      {missing.length > 0 && (
        <div className="flex flex-col items-center gap-3 w-full">
          <Button
            className="gap-2"
            onClick={() => onSetupWithAI?.(aiPrompt)}
          >
            <HugeiconsIcon icon={AiChat02Icon} size={16} />
            Set up with AI
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            The AI will install and configure the missing services for you.
          </p>
        </div>
      )}
    </div>
  );
}

function DepRow({ dep, onNavigate }: { dep: DepStatusResult; onNavigate: (path: string) => void }) {
  const statusConfig = {
    "configured": { icon: Tick01Icon, color: "text-status-healthy", label: "Ready" },
    "installed-not-configured": { icon: Settings01Icon, color: "text-status-warning", label: "Needs configuration" },
    "not-installed": { icon: Download01Icon, color: "text-muted-foreground/40", label: "Not installed" },
    "error": { icon: Settings01Icon, color: "text-status-critical", label: "Error" },
  }[dep.status];

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/10 transition-colors">
      <HugeiconsIcon
        icon={statusConfig.icon}
        size={14}
        className={cn("shrink-0", statusConfig.color)}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm">{dep.label}</p>
        {dep.alternatives && dep.alternatives.length > 0 && dep.status !== "configured" && (
          <p className="text-xs text-muted-foreground">
            or {dep.alternatives.join(", ")}
          </p>
        )}
      </div>
      <span className={cn("text-xs", statusConfig.color)}>
        {dep.required ? statusConfig.label : dep.status === "configured" ? "Ready" : "Optional"}
      </span>
      {dep.status === "installed-not-configured" && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => onNavigate("/dashboard/settings/connections")}
        >
          Configure
        </Button>
      )}
      {dep.status === "not-installed" && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => onNavigate(`/dashboard/apps?search=${dep.appId}`)}
        >
          Install
        </Button>
      )}
    </div>
  );
}
