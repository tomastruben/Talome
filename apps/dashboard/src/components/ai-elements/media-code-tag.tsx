"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useMediaDetail } from "@/components/media/media-detail-context";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { useContainers } from "@/hooks/use-containers";
import { cn } from "@/lib/utils";

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  node?: unknown;
  toolIntent?: "unknown" | "media" | "containers" | "mixed";
};

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Match a backtick label to a container by name, compose service label, or image basename. */
function findMatchingContainer<T extends { name: string; image: string; labels: Record<string, string> }>(
  label: string,
  containers: T[]
): T | undefined {
  const normalized = normalizeLabel(label);
  if (!normalized) return undefined;
  return containers.find((c) => {
    // Exact name match (most common)
    if (normalizeLabel(c.name) === normalized) return true;
    // Compose service name (e.g., "qbittorrent" for container named "talome-qbittorrent-1")
    const service = c.labels["com.docker.compose.service"];
    if (service && normalizeLabel(service) === normalized) return true;
    // Image basename without tag (e.g., "jellyfin" matches "jellyfin/jellyfin:10.8")
    const imageName = c.image.split("/").pop()?.split(":")[0];
    if (imageName && normalizeLabel(imageName) === normalized) return true;
    return false;
  });
}

function isLikelyMediaReference(title: string, inLibrary: boolean): boolean {
  if (inLibrary) return true;

  const trimmed = title.trim();
  if (!trimmed) return false;
  // Filesystem paths (e.g., `/Volumes/Media Hub`) are never media references.
  if (/^[~.]?\//.test(trimmed)) return false;
  // Tool names and technical identifiers should stay plain inline code.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;

  const hasYear = /\b(19|20)\d{2}\b/.test(trimmed);
  const hasMultipleWords = /\s/.test(trimmed);
  const hasTitleCase = /^[A-Z]/.test(trimmed);
  const looksLikeSlug = /^[a-z0-9._-]+$/i.test(trimmed) && trimmed === trimmed.toLowerCase();
  const hasUnicodeFraction = /[¼½¾⅐-⅞]/.test(trimmed);
  const hasNonAscii = /[^\x00-\x7F]/.test(trimmed);
  const hasLetterAndDigit = /[a-z]/i.test(trimmed) && /\d/.test(trimmed);
  const isShortStylized = trimmed.length <= 8 && /[^a-z0-9\s]/i.test(trimmed);

  if (hasYear || hasMultipleWords) return true;
  if (hasUnicodeFraction) return true;
  if (hasLetterAndDigit) return true;
  if (isShortStylized && hasNonAscii) return true;
  if (hasTitleCase && !looksLikeSlug) return true;
  return false;
}

/**
 * Drop-in replacement for <code> inside Streamdown.
 * - Block code (language-* className) → plain <code> pass-through.
 * - Inline code that matches a library item → interactive media tag (library style).
 * - Inline code with no library match → still interactive, triggers a Radarr/Sonarr
 *   metadata lookup and opens a "peek" sheet with an Add to Library button.
 */
export function MediaCodeTag({ className, children, toolIntent = "unknown", ...props }: CodeProps) {
  const { openDetail, findItem } = useMediaDetail();
  const quickLook = useQuickLook();
  const { containers } = useContainers();

  const isBlock = className?.startsWith("language-");
  const title = typeof children === "string" ? children : "";

  if (isBlock || !title) {
    return <code className={className} {...props}>{children}</code>;
  }

  const matchingContainer = findMatchingContainer(title, containers);
  const inLibrary = !!findItem(title);
  const mediaLikely = isLikelyMediaReference(title, inLibrary);

  const shouldPreferMedia = toolIntent === "media";
  const shouldPreferContainers = toolIntent === "containers";
  const canOpenContainer = shouldPreferMedia ? false : !!matchingContainer;
  const canOpenMedia = shouldPreferContainers ? false : mediaLikely;
  const isInteractive = canOpenContainer || canOpenMedia;

  if (!isInteractive) {
    return <code className={className} {...props}>{children}</code>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (canOpenContainer && matchingContainer) {
          quickLook.open(matchingContainer);
          return;
        }
        openDetail(title);
      }}
      className={cn("media-tag", !inLibrary && "media-tag--lookup", className)}
      title={
        canOpenContainer && matchingContainer
          ? `Open "${title}" preview`
          : inLibrary
          ? `View "${title}" details`
          : `Look up "${title}"`
      }
    >
      {children}
    </button>
  );
}
