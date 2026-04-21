import { Skeleton } from "@/components/ui/skeleton";

export default function AppsLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Search + filters */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 flex-1 rounded-lg" />
        <Skeleton className="h-10 w-28 rounded-lg" />
      </div>

      {/* Category pills */}
      <div className="flex gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>

      {/* App grid */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-1.5 h-3 w-32" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
