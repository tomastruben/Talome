"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { HugeiconsIcon, Tv01Icon, Film01Icon, Calendar01Icon } from "@/components/icons";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList, WidgetListState, WidgetListSkeleton } from "./list-widget";

interface CalendarData {
  episodes: {
    id: number;
    seriesTitle: string;
    title: string;
    season: number;
    episode: number;
    airDate: string;
  }[];
  movies: {
    id: number;
    title: string;
    releaseDate?: string;
  }[];
}

function formatAirDate(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load media calendar");
  return res.json();
};

export function MediaCalendarWidget() {
  const { data: calendar, isLoading, error } = useSWR<CalendarData>(
    `${CORE_URL}/api/media/calendar`,
    fetcher,
    { refreshInterval: 60000 }
  );

  const episodes = calendar?.episodes ?? [];
  const movies = calendar?.movies ?? [];
  const hasItems = episodes.length > 0 || movies.length > 0;

  return (
    <Widget>
      <WidgetHeader title="Coming Up" href="/dashboard/media" hrefLabel="Media" />
      {isLoading ? (
        <WidgetList>
          <WidgetListSkeleton rows={6} />
        </WidgetList>
      ) : error ? (
        <WidgetListState icon={Calendar01Icon} message="Calendar unavailable." />
      ) : !hasItems ? (
        <WidgetListState icon={Calendar01Icon} message="No upcoming releases." />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {episodes.map((ep) => (
              <div key={`ep-${ep.id}`} className="flex items-center gap-2.5 px-4 py-2.5">
                <HugeiconsIcon icon={Tv01Icon} size={13} className="text-dim-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate font-medium">{ep.seriesTitle}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")} · {ep.title}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0 tabular-nums">
                  {formatAirDate(ep.airDate)}
                </span>
              </div>
            ))}
            {movies.map((m) => (
              <div key={`mv-${m.id}`} className="flex items-center gap-2.5 px-4 py-2.5">
                <HugeiconsIcon icon={Film01Icon} size={13} className="text-dim-foreground shrink-0" />
                <p className="flex-1 text-sm truncate font-medium">{m.title}</p>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0 tabular-nums">
                  {m.releaseDate ? formatAirDate(m.releaseDate) : "TBA"}
                </span>
              </div>
            ))}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
