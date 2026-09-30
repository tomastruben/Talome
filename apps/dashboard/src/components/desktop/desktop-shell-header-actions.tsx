"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import {
  desktopShellActionsAtom,
  type DesktopAppAction,
} from "@/atoms/desktop-app-actions";
import { pageTitleAtom } from "@/atoms/page-title";
import { useAutomation } from "@/components/automations/automation-context";
import { useWidgetEdit } from "@/components/widgets/widget-edit-context";
import { useWidgetLayout } from "@/hooks/use-widget-layout";
import { useCheckServiceUpdates } from "@/hooks/use-check-service-updates";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import { toast } from "sonner";

function usePublishShellActions(actions: DesktopAppAction[]) {
  const setShellActions = useSetAtom(desktopShellActionsAtom);

  useEffect(() => {
    setShellActions(actions);
    return () => setShellActions([]);
  }, [actions, setShellActions]);
}

function HomeShellActions() {
  const router = useRouter();
  const { editMode, setEditMode } = useWidgetEdit();
  const { resetLayout, restoreLayout } = useWidgetLayout();

  const handleReset = useCallback(() => {
    const previousLayout = resetLayout();
    toast("Layout reset to default", {
      action: {
        label: "Undo",
        onClick: () => restoreLayout(previousLayout),
      },
    });
  }, [resetLayout, restoreLayout]);

  const handleShare = useCallback(() => {
    if (!requestDesktopNavigation("/dashboard/share")) {
      router.push("/dashboard/share");
    }
  }, [router]);

  const handleEdit = useCallback(() => {
    setEditMode((current) => !current);
  }, [setEditMode]);

  const actions = useMemo<DesktopAppAction[]>(() => [
    ...(editMode ? [{
      id: "home-reset-layout",
      label: "Reset",
      onSelect: handleReset,
    }] : []),
    {
      id: "home-share",
      label: "Share",
      onSelect: handleShare,
    },
    {
      id: "home-edit-widgets",
      label: editMode ? "Done" : "Edit",
      active: editMode,
      onSelect: handleEdit,
    },
  ], [editMode, handleEdit, handleReset, handleShare]);

  usePublishShellActions(actions);
  return null;
}

function AutomationsShellActions() {
  const { openCreate } = useAutomation();
  const actions = useMemo<DesktopAppAction[]>(() => [{
    id: "automation-new",
    label: "New",
    icon: "add",
    onSelect: openCreate,
  }], [openCreate]);

  usePublishShellActions(actions);
  return null;
}

function AppStoreShellActions() {
  const router = useRouter();
  const setPageTitle = useSetAtom(pageTitleAtom);
  const handleCreate = useCallback(() => {
    const href = "/dashboard/assistant?prompt=I+want+to+create+a+new+app";
    if (!requestDesktopNavigation(href)) router.push(href);
  }, [router]);
  const actions = useMemo<DesktopAppAction[]>(() => [{
    id: "app-store-create",
    label: "Create",
    icon: "add",
    onSelect: handleCreate,
  }], [handleCreate]);

  useEffect(() => {
    setPageTitle(null);
  }, [setPageTitle]);

  usePublishShellActions(actions);
  return null;
}

function ServicesShellActions() {
  const checkAllUpdates = useCheckServiceUpdates();
  const actions = useMemo<DesktopAppAction[]>(() => [{
    id: "services-check-updates",
    label: "Check updates",
    onSelect: checkAllUpdates,
  }], [checkAllUpdates]);

  usePublishShellActions(actions);
  return null;
}

function RouteBackShellAction({ home = false }: { home?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const embeddedFrame = useIsEmbeddedFrame();
  const handleBack = useCallback(() => {
    if (!home) {
      // An app can open directly on a detail page. Browser history belongs to
      // the whole desktop tab and may otherwise take a different window back.
      if (embeddedFrame) {
        const destination = pathname.endsWith("/configure")
          ? pathname.slice(0, -"/configure".length)
          : pathname.startsWith("/dashboard/settings/")
            ? "/dashboard/settings"
            : "/dashboard/apps";
        router.push(destination);
        return;
      }
      router.back();
      return;
    }
    if (!requestDesktopNavigation("/dashboard")) router.push("/dashboard");
  }, [embeddedFrame, home, pathname, router]);
  // A root desktop window has no dashboard parent; Close returns to the desktop.
  const actions = useMemo<DesktopAppAction[]>(() => home && embeddedFrame ? [] : [{
    id: "shell-route-back",
    label: "Back",
    icon: "back",
    placement: "leading",
    onSelect: handleBack,
  }], [embeddedFrame, handleBack, home]);

  usePublishShellActions(actions);
  return null;
}

function EmptyShellActions() {
  const actions = useMemo<DesktopAppAction[]>(() => [], []);
  usePublishShellActions(actions);
  return null;
}

export function DesktopShellHeaderActions() {
  const pathname = usePathname();

  if (pathname === "/dashboard") return <HomeShellActions />;
  if (pathname === "/dashboard/automations") return <AutomationsShellActions />;
  if (pathname === "/dashboard/apps") return <AppStoreShellActions />;
  if (pathname === "/dashboard/containers") return <ServicesShellActions />;
  if (pathname === "/dashboard/share") return <RouteBackShellAction home />;
  if (pathname.startsWith("/dashboard/settings/")) return <RouteBackShellAction />;
  if (pathname.startsWith("/dashboard/apps/")) return <RouteBackShellAction />;

  return <EmptyShellActions />;
}
