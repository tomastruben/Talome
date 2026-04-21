"use client";

import Image from "next/image";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { CORE_URL } from "@/lib/constants";
import { HugeiconsIcon, BookOpen01Icon } from "@/components/icons";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList, WidgetListState, WidgetListSkeleton } from "./list-widget";

interface AudiobookEntity {
  id: string;
  media: {
    metadata: {
      title: string;
      authorName?: string;
    };
    duration?: number;
  };
  mediaProgress?: {
    progress: number;
    currentTime: number;
    isFinished: boolean;
  };
}

interface PersonalizedShelf {
  id: string;
  label: string;
  labelStringKey?: string;
  entities: AudiobookEntity[];
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRemaining(progress: number, duration: number): string {
  const remaining = (1 - progress) * duration;
  return formatDuration(remaining) + " left";
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load audiobooks");
  return res.json();
};

export function AudiobooksWidget({ libraryId }: { libraryId?: string }) {
  const router = useRouter();

  // If no library ID, fetch libraries first
  const { data: libraries } = useSWR<{ id: string; name: string }[]>(
    !libraryId ? `${CORE_URL}/api/audiobooks/libraries` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const effectiveLibraryId = libraryId ?? libraries?.[0]?.id;

  const { data: shelves, isLoading, error } = useSWR<PersonalizedShelf[]>(
    effectiveLibraryId
      ? `${CORE_URL}/api/audiobooks/library/${effectiveLibraryId}/personalized`
      : null,
    fetcher,
    { refreshInterval: 120000 },
  );

  const continueListening = shelves?.find(
    (s) => s.id === "continue-listening" || s.labelStringKey === "LabelContinueListening",
  );

  const items = continueListening?.entities?.filter((e) => !e.mediaProgress?.isFinished) ?? [];

  return (
    <Widget>
      <WidgetHeader title="Continue Listening" href="/dashboard/audiobooks" hrefLabel="Audiobooks" />
      {isLoading ? (
        <WidgetList>
          <WidgetListSkeleton rows={4} />
        </WidgetList>
      ) : error || !effectiveLibraryId ? (
        <WidgetListState icon={BookOpen01Icon} message="Connect Audiobookshelf in Settings." />
      ) : items.length === 0 ? (
        <WidgetListState icon={BookOpen01Icon} message="No audiobooks in progress." />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {items.slice(0, 6).map((item) => {
              const progress = item.mediaProgress?.progress ?? 0;
              const duration = item.media?.duration ?? 0;
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/20 transition-colors"
                  onClick={() => router.push(`/dashboard/audiobooks/${item.id}`)}
                >
                  {/* Mini cover */}
                  <div className="relative w-9 h-9 rounded bg-muted/40 overflow-hidden shrink-0">
                    <Image
                      src={`${CORE_URL}/api/audiobooks/cover?id=${item.id}&w=120`}
                      alt=""
                      className="object-cover"
                      fill
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate font-medium">{item.media?.metadata?.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {item.media?.metadata?.authorName}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {Math.round(progress * 100)}%
                    </p>
                    {duration > 0 && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatRemaining(progress, duration)}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
