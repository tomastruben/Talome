import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the page: the summary, the promise and the list of apps. No
 * padding of its own, since the shell pads the page (classic and window alike).
 */
export default function BackupsLoading() {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6" aria-busy="true">
      <Skeleton className="h-5 w-72 max-w-full" />
      <Skeleton className="-mt-3 h-4 w-96 max-w-full" />
      <div className="divide-y divide-border overflow-hidden rounded-lg border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
