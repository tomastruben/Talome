import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the list of automations. No padding of its own, since the shell
 * pads the page (classic and window alike).
 */
export default function AutomationsLoading() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-1 flex-col gap-2" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}
