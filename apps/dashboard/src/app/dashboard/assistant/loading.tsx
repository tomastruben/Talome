import { Skeleton } from "@/components/ui/skeleton";

export default function AssistantLoading() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-1 flex-col items-center justify-end gap-3 pb-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton
            key={i}
            className="w-full max-w-2xl"
            style={{ height: i % 2 === 0 ? 72 : 48 }}
          />
        ))}
      </div>
      <div className="mx-auto w-full max-w-2xl">
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    </div>
  );
}
