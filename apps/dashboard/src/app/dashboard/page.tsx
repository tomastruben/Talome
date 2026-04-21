"use client";

import { Suspense } from "react";
import { WelcomeCard } from "@/components/welcome-card";
import { WidgetGrid } from "@/components/widgets/widget-grid";
import { Skeleton } from "@/components/ui/skeleton";

function DashboardContent() {
  return (
    <div className="grid gap-4">
      <WelcomeCard />
      <WidgetGrid />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="grid gap-4">
          <Skeleton className="h-[120px] rounded-xl" />
          <Skeleton className="h-[400px] rounded-xl" />
        </div>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
