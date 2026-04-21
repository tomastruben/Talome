import { Skeleton } from "@/components/ui/skeleton";

function CategorySkeleton({ rows }: { rows: number }) {
  return (
    <section>
      <Skeleton className="h-3.5 w-20 mb-2 ml-1" />
      <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3.5 flex items-center gap-3">
            <Skeleton className="size-8 rounded-lg shrink-0" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="size-3.5 shrink-0" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function SettingsLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl min-w-0 grid gap-8 pb-12">
      {/* General (toggle + mode + info) */}
      <section>
        <Skeleton className="h-3.5 w-16 mb-2 ml-1" />
        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
          <div className="px-4 py-3.5 flex items-center justify-between">
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
          <div className="px-4 py-3.5">
            <Skeleton className="h-4 w-24 mb-3" />
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </div>
          </div>
          <div className="px-4 py-3.5 flex items-center justify-between">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      </section>

      {/* Services (3 rows) */}
      <CategorySkeleton rows={3} />

      {/* Access (1 row) */}
      <CategorySkeleton rows={1} />

      {/* AI (6 rows) */}
      <CategorySkeleton rows={6} />

      {/* Infrastructure (6 rows) */}
      <CategorySkeleton rows={6} />

      {/* Connections (2 rows) */}
      <CategorySkeleton rows={2} />

      {/* Developer (4 rows) */}
      <CategorySkeleton rows={4} />
    </div>
  );
}
