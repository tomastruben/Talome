import { Skeleton } from "@/components/ui/skeleton";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";

/**
 * Shaped like the library: the toolbar (in a window, in the window's toolbar
 * row), then the poster grid. The grid uses .media-grid, so its density
 * follows the content column exactly as the loaded grid does.
 */
export default function MediaLoading() {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6" aria-busy="true">
      <DesktopAppToolbar className="flex min-w-0 items-center gap-2">
        <Skeleton className="h-8 w-64 max-w-full" />
      </DesktopAppToolbar>
      <div className="media-grid" aria-hidden="true">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i} className="min-w-0">
            <Skeleton className="aspect-2/3 w-full rounded-lg" />
            <Skeleton className="mt-2 h-4 w-3/4" />
            <Skeleton className="mt-1.5 h-4 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
