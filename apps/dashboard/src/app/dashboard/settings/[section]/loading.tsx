import { Skeleton } from "@/components/ui/skeleton";

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <section>
      <Skeleton className="h-3.5 w-24 mb-2 ml-1" />
      <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3.5 flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full shrink-0" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function SettingsSectionLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl min-w-0 grid gap-8">
      <SectionSkeleton rows={3} />
      <SectionSkeleton rows={2} />
    </div>
  );
}
