import Link from "next/link";
import { HugeiconsIcon, ArrowRight01Icon } from "@/components/icons";
import { InlineMarkdown } from "@/components/ui/inline-markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/empty-state";
import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { SuggestionRow, type Suggestion } from "../../evolution/components/suggestion-card";

// ── Insights Widget ─────────────────────────────────────────────────────────

interface InsightsWidgetProps {
  summaryLines: string[];
  intelligenceDisabledExplicitly: boolean;
}

export function InsightsWidget({ summaryLines, intelligenceDisabledExplicitly }: InsightsWidgetProps) {
  if (summaryLines.length === 0 && !intelligenceDisabledExplicitly) return null;

  return (
    <Widget className="h-auto">
      <WidgetHeader title="Insights" />
      <div className="px-4 py-3 space-y-2">
        {summaryLines.map((line, i) => (
          <p key={i} className="text-sm text-muted-foreground leading-relaxed">
            <InlineMarkdown text={line} />
          </p>
        ))}
        {intelligenceDisabledExplicitly && (
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Background intelligence is paused.
            </p>
            <Link
              href="/dashboard/settings/intelligence"
              className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
            >
              Enable
              <HugeiconsIcon icon={ArrowRight01Icon} size={10} />
            </Link>
          </div>
        )}
      </div>
    </Widget>
  );
}

// ── Suggestions Widget ──────────────────────────────────────────────────────

interface SuggestionsWidgetProps {
  suggestions: Suggestion[];
  suggestionsLoading: boolean;
  suggestionsError: Error | undefined;
  onExecute: (suggestion: Suggestion) => void;
  onDismiss: (id: string, reason?: string) => void;
  onView: (suggestion: Suggestion) => void;
  onReinject: (runId: string, auto?: boolean) => void;
  onMarkDone: (id: string) => void;
  onRetrySuggestions: () => void;
}

export function SuggestionsWidget({
  suggestions,
  suggestionsLoading,
  suggestionsError,
  onExecute,
  onDismiss,
  onView,
  onReinject,
  onMarkDone,
  onRetrySuggestions,
}: SuggestionsWidgetProps) {
  if (!suggestionsLoading && !suggestionsError && suggestions.length === 0) return null;

  return (
    <Widget className="h-auto">
      <WidgetHeader
        title="Suggestions"
        actions={
          suggestions.length > 0 ? (
            <span className="text-xs text-muted-foreground">{suggestions.length} pending</span>
          ) : undefined
        }
      />
      <div>
        {suggestionsError && (
          <div className="px-4 py-3">
            <ErrorState
              title="Couldn't load suggestions"
              description="Check that the Talome server is reachable."
              onRetry={onRetrySuggestions}
            />
          </div>
        )}

        {suggestionsLoading && (
          <div className="px-4 py-3 space-y-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-80" />
              </div>
            ))}
          </div>
        )}

        {!suggestionsLoading && !suggestionsError && suggestions.length > 0 && (
          <div className="divide-y divide-border/40">
            {suggestions.map((s) => (
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
        )}
      </div>
    </Widget>
  );
}
