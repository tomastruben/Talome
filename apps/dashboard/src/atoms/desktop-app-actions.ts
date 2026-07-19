import { atom } from "jotai";

const desktopAppActionIcons = [
  "projector",
  "upload",
  "new-folder",
] as const;

export type DesktopAppActionIcon = (typeof desktopAppActionIcons)[number];

export interface DesktopAppActionDescriptor {
  id: string;
  label: string;
  icon?: DesktopAppActionIcon;
  active?: boolean;
  disabled?: boolean;
}

export interface DesktopAppAction extends DesktopAppActionDescriptor {
  onSelect: () => void;
}

export const desktopAppActionsAtom = atom<DesktopAppAction[]>([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function parseDesktopAppActionDescriptor(
  value: unknown,
): DesktopAppActionDescriptor | null {
  if (!isRecord(value) || !isBoundedString(value.id) || !isBoundedString(value.label)) {
    return null;
  }
  if (
    value.icon !== undefined &&
    !desktopAppActionIcons.includes(value.icon as DesktopAppActionIcon)
  ) {
    return null;
  }
  if (value.active !== undefined && typeof value.active !== "boolean") return null;
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") return null;

  return {
    id: value.id,
    label: value.label,
    icon: value.icon as DesktopAppActionIcon | undefined,
    active: value.active,
    disabled: value.disabled,
  };
}

export function parseDesktopAppActionsMessage(value: unknown) {
  if (
    !isRecord(value) ||
    value.type !== "talome:desktop-app-actions" ||
    !Array.isArray(value.actions) ||
    value.actions.length > 8
  ) {
    return null;
  }
  const actions = value.actions.map(parseDesktopAppActionDescriptor);
  if (actions.some((action) => action === null)) return null;
  return {
    type: "talome:desktop-app-actions" as const,
    actions: actions as DesktopAppActionDescriptor[],
  };
}

export function parseDesktopAppActionTriggerMessage(value: unknown) {
  if (
    !isRecord(value) ||
    value.type !== "talome:desktop-app-action-trigger" ||
    !isBoundedString(value.actionId)
  ) {
    return null;
  }
  return {
    type: "talome:desktop-app-action-trigger" as const,
    actionId: value.actionId,
  };
}

export function parseDesktopAppFocusMessage(value: unknown) {
  if (!isRecord(value) || value.type !== "talome:desktop-app-focus") {
    return null;
  }
  return { type: "talome:desktop-app-focus" as const };
}
