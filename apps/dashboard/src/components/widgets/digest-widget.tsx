"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import Link from "next/link";
import { HugeiconsIcon, ArrowRight01Icon, SparklesIcon } from "@/components/icons";
import { MessageResponse } from "@/components/ai-elements/message";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList, WidgetListState, WidgetListSkeleton } from "./list-widget";

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function DigestWidget() {
  const { data: settings } = useSWR<Record<string, string>>(
    `${CORE_URL}/api/settings`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );

  const digestId = settings?.latest_digest_id;
  const digestAt = settings?.latest_digest_at;

  const { data: messages, isLoading } = useSWR<
    { id: string; role: string; content: string; createdAt: string }[]
  >(
    digestId ? `${CORE_URL}/api/conversations/${digestId}/messages` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const digest = messages?.find((m) => m.role === "assistant");

  if (isLoading || (digestId && !messages)) {
    return (
      <Widget>
        <WidgetHeader title="Weekly Digest" />
        <WidgetList>
          <WidgetListSkeleton rows={4} />
        </WidgetList>
      </Widget>
    );
  }

  if (!digestId || !digest) {
    return (
      <Widget>
        <WidgetHeader title="Weekly Digest" />
        <WidgetListState
          icon={SparklesIcon}
          message="No digest yet. Digests are generated weekly."
        />
      </Widget>
    );
  }

  return (
    <Widget>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={SparklesIcon} size={14} className="text-dim-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Weekly Digest
          </span>
          {digestAt && (
            <span className="text-xs text-muted-foreground tabular-nums">
              — {formatDate(digestAt)}
            </span>
          )}
        </div>
        <Link
          href="/dashboard/assistant"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Open in Assistant
          <HugeiconsIcon icon={ArrowRight01Icon} size={11} />
        </Link>
      </div>
      <WidgetList className="px-4 py-4 text-sm prose-sm">
        <MessageResponse>{digest.content}</MessageResponse>
      </WidgetList>
    </Widget>
  );
}
