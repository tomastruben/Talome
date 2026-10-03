import Link from "next/link";
import { CompassIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function DashboardNotFound() {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <EmptyState
        fill
        icon={CompassIcon}
        title="Page not found"
        description="This page doesn't exist, or it moved. Go back to the dashboard to find what you need."
        action={
          <Button variant="outline" size="sm" className="phone-touch:h-11" asChild>
            <Link href="/dashboard">Go to the dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}
