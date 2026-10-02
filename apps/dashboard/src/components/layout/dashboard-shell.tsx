"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAtomValue } from "jotai";
import { WindowSidebarSlot } from "@/components/ui/source-list";
import { WindowStatusBarSlot } from "@/components/desktop/window-content";
import { WindowToolbar } from "@/components/desktop/window-toolbar";
import { WindowDragBridge } from "@/components/desktop/window-drag";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SiteHeader } from "@/components/layout/site-header";
import { MediaDetailProvider } from "@/components/media/media-detail-context";
import { AssistantProvider } from "@/components/assistant/assistant-context";
import { CommandPaletteLauncher } from "@/components/assistant/command-palette-launcher";
import { WidgetEditProvider } from "@/components/widgets/widget-edit-context";
import { AutomationProvider } from "@/components/automations/automation-context";
import { SystemHealthBanner } from "@/components/system-health-banner";
import { QuickLookProvider } from "@/components/quick-look/quick-look-context";
import { QuickLookModal } from "@/components/quick-look/quick-look";
import { BugHuntProvider } from "@/components/bug-hunt/bug-hunt-context";
import { BugHuntLauncher } from "@/components/bug-hunt/bug-hunt-launcher";
import { CinemaBrowserProvider } from "@/components/media/cinema-browser-context";
import { CinemaBrowserLauncher } from "@/components/media/cinema-browser-launcher";
import { NotificationToastBridge } from "@/components/notifications/notification-toast-bridge";
import { hideShellHeaderAtom } from "@/atoms/shell";
import { registerServiceWorker } from "@/lib/register-sw";
import {
  AudiobookAudioEngine,
  GlobalAudioPlayer,
} from "@/components/audiobooks/global-audio-player";
import { useUser } from "@/hooks/use-user";
import { DesktopAppActionBridge } from "@/components/desktop/desktop-app-action-bridge";
import { DesktopAudiobookPlayerBridge } from "@/components/desktop/desktop-audiobook-player-bridge";
import { DesktopShellHeaderActions } from "@/components/desktop/desktop-shell-header-actions";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { windowContentLayout } from "@/lib/window-layout";
import {
  canAccessDashboardRoute,
  firstAccessibleDashboardRoute,
} from "@/lib/dashboard-feature-access";

const subscribeNoop = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function DashboardShell({ children }: { children: React.ReactNode }) {
  // true only on the client after hydration (false during SSR and hydration)
  const mounted = useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);
  const router = useRouter();
  const pathname = usePathname();
  const embeddedFrame = useIsEmbeddedFrame();
  const desktopRoute = pathname === "/dashboard/desktop";
  const embeddedAudiobookRoute = embeddedFrame && pathname.startsWith("/dashboard/audiobooks");
  const windowLayout = windowContentLayout(pathname);
  const { user, isLoading: userLoading } = useUser();
  const routeAllowed = canAccessDashboardRoute(pathname, user?.role, user?.permissions);
  const restrictedLandingRoute = pathname === "/dashboard" && !routeAllowed;
  const contentScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { registerServiceWorker(); }, []);

  // The shell owns scrolling, so Next.js cannot reset it automatically when
  // an app navigates from a long list into a detail route. Always present a
  // new route from the top, especially inside desktop windows.
  useEffect(() => {
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [pathname]);

  // Client-side auth guard: redirect to login if user session is invalid.
  // This catches cases where the JWT expired or was invalidated but the
  // service worker served a cached page (bypassing the Next.js middleware).
  useEffect(() => {
    if (!userLoading && user && user.authenticated === false) {
      router.replace("/login");
    }
  }, [userLoading, user, router]);
  useEffect(() => {
    if (!userLoading && user?.authenticated && restrictedLandingRoute) {
      router.replace(firstAccessibleDashboardRoute(user.role, user.permissions));
    }
  }, [restrictedLandingRoute, router, user, userLoading]);
  const hideHeader = useAtomValue(hideShellHeaderAtom);

  if (userLoading || !user || user.authenticated === false || restrictedLandingRoute) {
    return (
      <main className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Opening an available app…
      </main>
    );
  }

  if (!routeAllowed) {
    return (
      <main className="flex h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-medium text-foreground">Access unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account does not have permission to use this feature.
          </p>
        </div>
      </main>
    );
  }

  return (
    <MediaDetailProvider>
      <AssistantProvider>
        <QuickLookProvider>
        <BugHuntProvider>
        <CinemaBrowserProvider>
        <WidgetEditProvider>
          <AutomationProvider>
          <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
            {/* Heavy overlays are code-split: each launcher is tiny and loads its
                overlay on first use (the palette is also preloaded when idle).
                Desktop windows are iframes running this same shell, so each
                window gets its own palette/Quick Look/Bug Hunt/Cinema; toasts
                are shown once, by the top-level page only. */}
            {mounted && <CommandPaletteLauncher />}
            {!embeddedFrame ? <NotificationToastBridge /> : null}
            <QuickLookModal />
            <BugHuntLauncher />
            <CinemaBrowserLauncher />
            {desktopRoute ? (
              <main id="main-content" className="h-dvh min-h-0 flex-1 overflow-hidden">
                {children}
              </main>
            ) : embeddedFrame ? (
              // A desktop window: the window's glass (parent document) shows
              // through wherever the app doesn't paint. The window draws no
              // title bar: the sidebar is a panel inset on the glass, and the
              // content column paints a thin tint and holds the unified
              // toolbar (Back, the title, the app's controls), the scroller
              // and the status bar (window-toolbar.tsx, window-content.tsx).
              // The window's controls float over the top-left corner. Empty
              // toolbar space and the sidebar's top drag the window, forwarded
              // to it by the drag bridge (window-drag.ts).
              <main id="main-content" className="@container/window relative flex h-dvh min-h-0 flex-1 flex-col overflow-hidden">
                {embeddedAudiobookRoute ? (
                  <>
                    <AudiobookAudioEngine />
                    <DesktopAudiobookPlayerBridge />
                  </>
                ) : null}
                <DesktopShellHeaderActions />
                <DesktopAppActionBridge />
                <WindowDragBridge />
                {/* The glass around the sidebar panel drags the window too */}
                <div data-window-drag-region="surface" className="flex min-h-0 flex-1">
                  <WindowSidebarSlot />
                  <div
                    data-window-content=""
                    className="tm-window-content @container/content relative flex min-h-0 min-w-0 flex-1 flex-col"
                  >
                    <WindowToolbar />
                    <div
                      ref={contentScrollRef}
                      data-content-scroll=""
                      data-window-layout={windowLayout}
                      className={
                        windowLayout === "fill"
                          ? "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                          : "tm-window-scroll relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-none"
                      }
                    >
                      {children}
                    </div>
                    <WindowStatusBarSlot />
                  </div>
                </div>
              </main>
            ) : (
              <>
              <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-2 focus:ring-ring"
              >
                Skip to main content
              </a>
              <AppSidebar />
              {/* On a phone the shell keeps clear of the status bar and the
                  home indicator once, for every page (a Home Screen web app
                  draws under both); md+ gets an inset margin in globals.css. */}
              <SidebarInset className="overflow-hidden flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:pt-0 md:pb-0">
                {!hideHeader && <SiteHeader />}
                <SystemHealthBanner />
                <main id="main-content" className={`flex-1 min-h-0 min-w-0 overflow-hidden relative flex flex-col ${hideHeader ? "" : "[container-type:inline-size]"}`}>
                  <div ref={contentScrollRef} data-content-scroll="" className={`flex-1 min-h-0 min-w-0 flex flex-col ${hideHeader ? "" : "overflow-y-auto p-4 pb-8 sm:p-6 sm:pb-10 overscroll-none"}`}>
                    {children}
                  </div>
                </main>
                <GlobalAudioPlayer />
              </SidebarInset>
              </>
            )}
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
