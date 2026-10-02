import Link from "next/link";
import { CompassIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col p-6">
      <EmptyState
        fill
        icon={CompassIcon}
        title="Page not found"
        description="This page doesn't exist, or it moved. Go back to the dashboard to find what you need."
        action={
          <Button variant="outline" size="sm" className="pointer-coarse:h-11" asChild>
            <Link href="/dashboard">Go to the dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}
