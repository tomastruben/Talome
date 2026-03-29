import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { createElement } from "react";
import { HugeiconsIcon } from "@/components/icons";
import {
  Rocket01Icon,
  Book02Icon,
  Plug02Icon,
  FileSearchIcon,
  CommandLineIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

// Map icon strings (from meta.json) to HugeiconsIcon components
const iconMap: Record<string, IconSvgElement> = {
  Rocket01: Rocket01Icon,
  Book02: Book02Icon,
  Plug02: Plug02Icon,
  FileSearch: FileSearchIcon,
  CommandLine: CommandLineIcon,
};

function resolveIcon(name: string | undefined) {
  if (!name) return undefined;
  const icon = iconMap[name];
  if (!icon) return undefined;
  return createElement(HugeiconsIcon, { icon, size: 16 });
}

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  icon(icon) {
    return resolveIcon(icon);
  },
});
