import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { SuggestionRow, type Suggestion } from "../../evolution/components/suggestion-card";

interface ActiveTasksWidgetProps {
  tasks: Suggestion[];
  onExecute: (suggestion: Suggestion, auto?: boolean) => void;
  onDismiss: (id: string, reason?: string) => void;
  onView: (suggestion: Suggestion) => void;
  onReinject: (runId: string, auto?: boolean) => void;
  onMarkDone: (id: string) => void;
}

export function ActiveTasksWidget({
  tasks,
  onExecute,
  onDismiss,
  onView,
  onReinject,
  onMarkDone,
}: ActiveTasksWidgetProps) {
  if (tasks.length === 0) return null;

  return (
    <Widget className="h-auto">
      <WidgetHeader
        title="Active Tasks"
        actions={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="animate-pulse size-1.5 rounded-full bg-status-warning" />
            {tasks.length} running
          </span>
        }
      />
      <div className="divide-y divide-border/40">
        {tasks.map((s) => (
          <SuggestionRow
            key={s.id}
            suggestion={s}
            onExecute={onExecute}
            onDismiss={onDismiss}
            onView={onView}
            onReinject={onReinject}
            onMarkDone={onMarkDone}
          />
        ))}
      </div>
    </Widget>
  );
}
