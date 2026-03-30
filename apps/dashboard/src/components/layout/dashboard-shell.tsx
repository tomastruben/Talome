"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAtomValue } from "jotai";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SiteHeader } from "@/components/layout/site-header";
import { MediaDetailProvider } from "@/components/media/media-detail-context";
import { AssistantProvider } from "@/components/assistant/assistant-context";
import { CommandPalette } from "@/components/assistant/command-palette";
import { WidgetEditProvider } from "@/components/widgets/widget-edit-context";
import { AutomationProvider } from "@/components/automations/automation-context";
import { SystemHealthBanner } from "@/components/system-health-banner";
import { QuickLookProvider } from "@/components/quick-look/quick-look-context";
import { QuickLookModal } from "@/components/quick-look/quick-look";
import { BugHuntProvider } from "@/components/bug-hunt/bug-hunt-context";
import { BugHuntOverlay } from "@/components/bug-hunt/bug-hunt-overlay";
import { CinemaBrowserProvider } from "@/components/media/cinema-browser-context";
import { CinemaBrowserOverlay } from "@/components/media/cinema-browser";
import { NotificationToastBridge } from "@/components/notifications/notification-toast-bridge";
import { hideShellHeaderAtom } from "@/atoms/shell";
import { registerServiceWorker } from "@/lib/register-sw";
import { GlobalAudioPlayer } from "@/components/audiobooks/global-audio-player";
import { useUser } from "@/hooks/use-user";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { user, isLoading: userLoading } = useUser();
  useEffect(() => setMounted(true), []);
  useEffect(() => { registerServiceWorker(); }, []);

  // Client-side auth guard: redirect to login if user session is invalid.
  // This catches cases where the JWT expired or was invalidated but the
  // service worker served a cached page (bypassing the Next.js middleware).
  useEffect(() => {
    if (!userLoading && user && user.authenticated === false) {
      router.replace("/login");
    }
  }, [userLoading, user, router]);
  const hideHeader = useAtomValue(hideShellHeaderAtom);

  return (
    <MediaDetailProvider>
      <AssistantProvider>
        <QuickLookProvider>
        <BugHuntProvider>
        <CinemaBrowserProvider>
        <WidgetEditProvider>
          <AutomationProvider>
          {mounted && <CommandPalette />}
          <NotificationToastBridge />
          <QuickLookModal />
          <BugHuntOverlay />
          <CinemaBrowserOverlay />
          <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-ring"
            >
              Skip to main content
            </a>
            <AppSidebar />
            <SidebarInset className="overflow-hidden flex flex-col">
              {!hideHeader && <SiteHeader />}
              <SystemHealthBanner />
              <main id="main-content" className={`flex-1 min-h-0 min-w-0 overflow-hidden relative flex flex-col ${hideHeader ? "" : "[container-type:inline-size]"}`}>
                <div className={`flex-1 min-h-0 min-w-0 flex flex-col ${hideHeader ? "" : "overflow-y-auto p-4 pb-8 sm:p-6 sm:pb-10 overscroll-none"}`}>
                  {children}
                </div>
              </main>
              <GlobalAudioPlayer />
            </SidebarInset>
          </SidebarProvider>
          </AutomationProvider>
        </WidgetEditProvider>
        </CinemaBrowserProvider>
        </BugHuntProvider>
        </QuickLookProvider>
      </AssistantProvider>
    </MediaDetailProvider>
  );
}
