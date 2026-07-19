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
    router.push("/dashboard/share");
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
    router.push("/dashboard/assistant?prompt=I+want+to+create+a+new+app");
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
  const handleBack = useCallback(() => {
    if (home) router.push("/dashboard");
    else router.back();
  }, [home, router]);
  const actions = useMemo<DesktopAppAction[]>(() => [{
    id: "shell-route-back",
    label: "Back",
    icon: "back",
    placement: "leading",
    onSelect: handleBack,
  }], [handleBack]);

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
