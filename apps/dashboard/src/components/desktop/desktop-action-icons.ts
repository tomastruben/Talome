import {
  Add01Icon,
  AiMagicIcon,
  ArrowLeft01Icon,
  CloudUploadIcon,
  FolderAddIcon,
  Projector01Icon,
  RemoteControlIcon,
  SourceCodeCircleIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import type { DesktopAppActionIcon } from "@/atoms/desktop-app-actions";

/** The icons a page's published window actions may name (atoms/desktop-app-actions.ts). */
export const desktopActionIcons: Record<DesktopAppActionIcon, IconSvgElement> = {
  add: Add01Icon,
  assistant: AiMagicIcon,
  back: ArrowLeft01Icon,
  // A remote-control session, not Wi-Fi (CLAUDE.md Icons rule).
  remote: RemoteControlIcon,
  "source-code": SourceCodeCircleIcon,
  projector: Projector01Icon,
  upload: CloudUploadIcon,
  "new-folder": FolderAddIcon,
};
