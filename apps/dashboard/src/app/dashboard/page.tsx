"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";
import { WelcomeCard } from "@/components/welcome-card";
import { WidgetGrid } from "@/components/widgets/widget-grid";
import { Skeleton } from "@/components/ui/skeleton";
import {
  readDashboardModePreference,
  useDesktopModeAvailable,
} from "@/hooks/use-desktop-mode";
import { useUser } from "@/hooks/use-user";

function DashboardContent() {
  const router = useRouter();
  const desktopModeAvailable = useDesktopModeAvailable();
  const { user, isLoading: userLoading } = useUser();
  const preferredMode = readDashboardModePreference(user?.userId)
    ?? user?.preferences?.desktopMode;
  const openDesktop = desktopModeAvailable && preferredMode === "desktop";

  useEffect(() => {
    if (openDesktop) router.replace("/dashboard/desktop");
  }, [openDesktop, router]);

  if (desktopModeAvailable && (userLoading || openDesktop)) {
    return (
      <div className="grid gap-4" aria-label="Loading preferred dashboard mode">
        <Skeleton className="h-[120px] rounded-xl" />
        <Skeleton className="h-[400px] rounded-xl" />
      </div>
    );
  }

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
