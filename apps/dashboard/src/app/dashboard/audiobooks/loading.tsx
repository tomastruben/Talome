import { Skeleton } from "@/components/ui/skeleton";

export default function AudiobooksLoading() {
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
        <Skeleton className="h-8 w-48 rounded-md" />
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-36 rounded-md" />
        <Skeleton className="h-3.5 w-16" />
      </div>
      <div className="audiobook-grid">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="audiobook-card-cover !bg-muted" />
            <div className="mt-2.5 px-0.5 space-y-1.5">
              <Skeleton className="h-3.5" style={{ width: `${60 + (i * 13) % 30}%` }} />
              <div className="flex items-center gap-2">
                <Skeleton className="h-3" style={{ width: `${40 + (i * 17) % 35}%` }} />
                <Skeleton className="h-3 w-10 ml-auto" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
