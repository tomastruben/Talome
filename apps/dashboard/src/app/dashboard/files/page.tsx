"use client";

import { Fragment, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Suspense } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import dynamic from "next/dynamic";
import { useSetAtom } from "jotai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { enter, TRAVEL } from "@/lib/motion";
import { SelectMark } from "@/components/ui/micro";
import {
  HugeiconsIcon,
  Folder01Icon,
  FolderOpenIcon,
  FileAttachmentIcon,
  Download01Icon,
  Delete01Icon,
  Edit02Icon,
  MoreHorizontalIcon,
  CloudUploadIcon,
  ExternalDriveIcon,
  HardDriveIcon,
  Cancel01Icon,
  ArrowRight01Icon,
  FolderExportIcon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  PinIcon,
  PinOffIcon,
  Search01Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { UploadPanel } from "@/components/files/upload-panel";
import { useUploadQueue, filesFromDrop, filesFromInput, type PendingFile } from "@/components/files/use-upload-queue";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { StaleRow, useLoadedAt, useLoadingPhase } from "@/components/data-state/data-state";
import {
  SEARCH_MIN_CHARS,
  displaySegments,
  ext,
  fileIcon,
  filesCountLabel,
  filterByQuery,
  folderErrorCopy,
  formatDate,
  isAudioPreviewable,
  isImagePreviewable,
  isMarkdownFile,
  isOverTextPreviewLimit,
  isPDF,
  isPreviewable,
  isSvgFile,
  isVideoPreviewable,
  listDataIsFor,
  needsTextFetch,
  parentPath,
  samePath,
  shouldHandleQuickLookKey,
  uniqueName,
  type FileItem,
} from "@/components/files/file-helpers";
import { FilesActions, FilesToolbar, type FilesSearchScope } from "@/components/files/files-toolbar";
import { SelectionBar, SelectionBarButton } from "@/components/files/selection-bar";
import { FilesStatusBar } from "@/components/files/files-status-bar";
import { FILES_FIRST_CELL, FILES_LAST_CELL, FilesColGroup, FilesListHeader } from "@/components/files/files-list-header";
import { FileSearchResults, HighlightedName } from "@/components/files/file-search-results";
import { useFileSearch } from "@/components/files/use-file-search";
import { fetchJson, fetchErrorStatus } from "@/lib/fetch-json";
import { SHORTCUTS } from "@/lib/keymap";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { pageActionAtom } from "@/atoms/page-action";
import { pageTitleAtom } from "@/atoms/page-title";
import { pageBackAtom } from "@/atoms/page-back";
import { Progress } from "@/components/ui/progress";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSystemStats } from "@/hooks/use-system-stats";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { FilesSidebar, useFileFavorites } from "@/components/files/files-sidebar";
import { WindowSidebarLayout } from "@/components/ui/source-list";
import { isCodeHighlightable } from "@/lib/file-languages";
import { getVisibleFileRoots, type FileManagerRoot } from "@/lib/file-roots";
const VideoPlayer = dynamic(
  () => import("@/components/files/media-player").then((m) => ({ default: m.VideoPlayer })),
  { ssr: false },
);
const AudioPlayer = dynamic(
  () => import("@/components/files/media-player").then((m) => ({ default: m.AudioPlayer })),
  { ssr: false },
);
import { toast } from "sonner";
import type { IconSvgElement } from "@/components/icons";
import type { DiskMount } from "@talome/types";

const CodePreview = dynamic(
  () => import("@/components/file-preview/code-preview").then((m) => ({ default: m.CodePreview })),
  { ssr: false },
);
const MarkdownPreview = dynamic(
  () => import("@/components/file-preview/markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
  { ssr: false },
);
const ImagePreview = dynamic(
  () => import("@/components/file-preview/image-preview").then((m) => ({ default: m.ImagePreview })),
  { ssr: false },
);
const PDFPreview = dynamic(
  () => import("@/components/file-preview/pdf-preview").then((m) => ({ default: m.PDFPreview })),
  { ssr: false },
);

// ── Types ───────────────────────────────────────────────────────────────

interface ListResponse {
  path: string;
  parent: string | null;
  items: FileItem[];
  allowedRoots: string[];
  roots?: FileManagerRoot[];
}

interface ReadResponse {
  path: string;
  name: string;
  size: number;
  modified: string;
  content: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Throws on a failed request, so an API error shows an error state (with
// Retry) instead of a skeleton that never ends.
const fetcher = <T,>(url: string) => fetchJson<T>(url);

function rootLabel(rootPath: string): { label: string; icon: IconSvgElement } {
  const name = rootPath.split("/").filter(Boolean).pop() || rootPath;
  // External drives: /Volumes/*, /media/*, /mnt/*, /run/media/*
  if (rootPath.startsWith("/Volumes/") || rootPath.startsWith("/media/") || rootPath.startsWith("/run/media/") || rootPath.startsWith("/mnt/")) {
    return { label: name, icon: ExternalDriveIcon };
  }
  if (rootPath.includes(".talome/files")) return { label: "Talome Files", icon: FolderOpenIcon };
  if (rootPath.includes(".talome")) return { label: "Talome", icon: HardDriveIcon };
  if (rootPath.includes("/tmp")) return { label: "Temp", icon: Folder01Icon };
  return { label: name, icon: Folder01Icon };
}

// ── Skeleton for file table loading state ────────────────────────────────

function FilesTableSkeleton({ rows = 12 }: { rows?: number }) {
  // Varying name widths for visual realism
  const nameWidths = ["w-28", "w-36", "w-24", "w-40", "w-32", "w-20", "w-44", "w-28", "w-36", "w-32", "w-24", "w-40"];
  return (
    <Table className="table-fixed" containerClassName="overflow-visible" aria-busy="true">
      <FilesColGroup />
      <TableBody>
        {Array.from({ length: rows }).map((_, i) => (
          <TableRow key={i} className="h-10 border-transparent hover:bg-transparent phone-touch:h-11">
            <TableCell className={FILES_FIRST_CELL}>
              <div className="flex items-center justify-center">
                <SelectMark selected={false} className="text-dim-foreground" />
              </div>
            </TableCell>
            <TableCell className="overflow-hidden">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-5 rounded shrink-0" />
                <Skeleton className={cn("h-3.5 rounded", nameWidths[i % nameWidths.length])} />
              </div>
            </TableCell>
            <TableCell className="hidden @md:table-cell">
              <Skeleton className="h-3 w-16 rounded" />
            </TableCell>
            <TableCell className="hidden @md:table-cell text-right">
              {i % 3 !== 0 && <Skeleton className="h-3 w-10 rounded ml-auto" />}
            </TableCell>
            <TableCell className={FILES_LAST_CELL} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function getDiskColor(percent: number): string {
  if (percent >= 90) return "text-destructive";
  if (percent >= 75) return "text-status-warning";
  return "text-muted-foreground";
}

function getProgressColor(percent: number): string {
  if (percent >= 90) return "[&>div]:bg-destructive";
  if (percent >= 75) return "[&>div]:bg-status-warning";
  return "";
}

/** Find the mount that best matches a file-browser root path. */
function findMountForRoot(root: string, mounts: DiskMount[]): DiskMount | undefined {
  // Exact match first, then longest prefix match
  return mounts.find((m) => m.mount === root)
    || mounts
      .filter((m) => root.startsWith(m.mount === "/" ? "/" : m.mount + "/"))
      .sort((a, b) => b.mount.length - a.mount.length)[0];
}

// ── Root-level volume list with disk stats ──────────────────────────────

function RootsList({ roots, onSelect }: { roots: FileManagerRoot[]; onSelect: (root: string) => void }) {
  const { stats } = useSystemStats();
  const mounts = stats?.disk.mounts ?? [];

  return (
    <div className="flex flex-1 flex-col justify-center px-[var(--window-pad,0.75rem)] py-6">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-3">
        {roots.map((root) => {
          const icon = root.kind === "talome-files" ? FolderOpenIcon : ExternalDriveIcon;
          const mount = root.kind === "external"
            ? findMountForRoot(root.hostMount ?? root.path, mounts)
            : undefined;
          const freeBytes = mount ? mount.totalBytes - mount.usedBytes : null;

          return (
            <button
              key={root.id}
              onClick={() => onSelect(root.path)}
              className="flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-colors hover:bg-muted/30 text-left group"
            >
              <div className="flex items-center justify-center size-8 rounded-lg bg-muted shrink-0">
                <HugeiconsIcon icon={icon} size={14} className="text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium leading-snug">{root.label}</p>
                {root.kind === "talome-files" ? (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    User files{root.hostLabel ? ` · Stored on ${root.hostLabel}` : ""}
                  </p>
                ) : mount ? (
                  <>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Progress
                        value={mount.percent}
                        className={cn("h-1 flex-1", getProgressColor(mount.percent))}
                      />
                      <span className={cn("text-xs tabular-nums shrink-0", getDiskColor(mount.percent))}>
                        {Math.round(mount.percent)}%
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                      {formatBytes(freeBytes!)} free of {formatBytes(mount.totalBytes)}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground mt-0.5">{root.path}</p>
                )}
              </div>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={16}
                className="shrink-0 text-dim-foreground group-hover:text-muted-foreground transition-colors"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Quick Look — fullscreen file preview ─────────────────────────────────

function FileQuickLook({
  filePath,
  onClose,
  onDownload,
  previewableFiles,
  fileSizes,
  onNavigate,
}: {
  filePath: string | null;
  onClose: () => void;
  onDownload: (path: string, name: string) => void;
  previewableFiles: string[];
  /** Sizes from the folder listing, so an oversized text file opens a "Too large" preview. */
  fileSizes: ReadonlyMap<string, number>;
  onNavigate: (path: string) => void;
}) {
  const fileName = filePath?.split("/").pop() || "";
  const knownSize = filePath ? fileSizes.get(filePath) : undefined;

  // Navigation state
  const currentIndex = filePath ? previewableFiles.indexOf(filePath) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < previewableFiles.length - 1;

  const goToPrev = useCallback(() => {
    if (hasPrev) onNavigate(previewableFiles[currentIndex - 1]);
  }, [hasPrev, currentIndex, previewableFiles, onNavigate]);

  const goToNext = useCallback(() => {
    if (hasNext) onNavigate(previewableFiles[currentIndex + 1]);
  }, [hasNext, currentIndex, previewableFiles, onNavigate]);

  // Arrow key navigation
  useEffect(() => {
    if (!filePath) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // The video player seeks with the arrows and marks the event handled
      // (it listens on document, which runs before window): don't also page.
      if (!shouldHandleQuickLookKey(e)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); goToPrev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); goToNext(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filePath, goToPrev, goToNext]);

  // Only fetch text content for text-based files, and only up to the 5MB
  // limit: bigger files open a "Too large" preview instead of doing nothing.
  const wantsText = filePath ? needsTextFetch(fileName) : false;
  const tooLargeBySize = wantsText && isOverTextPreviewLimit(knownSize);
  const shouldFetch = wantsText && !tooLargeBySize;
  const { data: file, error: fileError, isLoading, mutate: retryFile } = useSWR<ReadResponse>(
    shouldFetch ? `${CORE_URL}/api/files/read?path=${encodeURIComponent(filePath!)}` : null,
    fetcher,
    { shouldRetryOnError: false },
  );
  const tooLarge = tooLargeBySize || (shouldFetch && fetchErrorStatus(fileError) === 413);

  const _isImage = filePath ? isImagePreviewable(fileName) : false;
  const _isVideo = filePath ? isVideoPreviewable(fileName) : false;
  const _isAudio = filePath ? isAudioPreviewable(fileName) : false;
  const _isMd = filePath ? isMarkdownFile(fileName) : false;
  const _isPdf = filePath ? isPDF(fileName) : false;
  const _isSvg = filePath ? isSvgFile(fileName) : false;
  const _isCode = filePath ? isCodeHighlightable(ext(fileName)) : false;
  const streamUrl = filePath ? `${getDirectCoreUrl()}/api/files/stream?path=${encodeURIComponent(filePath)}` : "";
  const downloadUrl = filePath ? `${CORE_URL}/api/files/download?path=${encodeURIComponent(filePath)}` : "";
  const thumbnailUrl = filePath && _isImage && !_isSvg
    ? `${CORE_URL}/api/files/thumbnail?path=${encodeURIComponent(filePath)}&w=1920`
    : undefined;
  const { icon, color } = filePath
    ? fileIcon({ name: fileName, isDirectory: false })
    : { icon: FileAttachmentIcon, color: "" };

  const renderContent = () => {
    if (!filePath) return null;

    // Text over the preview limit (known from the listing, or a 413 from the server).
    if (tooLarge) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <EmptyState
            icon={FileAttachmentIcon}
            title="Too large to preview"
            description={`${knownSize !== undefined ? `${fileName} is ${formatBytes(knownSize)}. ` : ""}Quick Look shows text files up to 5 MB. Download it to open it in another app.`}
            action={
              <Button variant="outline" size="sm" onClick={() => onDownload(filePath, fileName)}>
                <HugeiconsIcon icon={Download01Icon} size={14} />
                Download
              </Button>
            }
            className="border-none"
          />
        </div>
      );
    }

    if (shouldFetch && fileError && !file) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <ErrorState
            title={`Couldn't load a preview of ${fileName}`}
            description={
              fetchErrorStatus(fileError) === 403
                ? "Talome doesn't have permission to read this file."
                : "Check that the Talome server is reachable, then retry."
            }
            onRetry={() => void retryFile()}
            className="border-none"
          />
        </div>
      );
    }

    // Video — full-bleed player, black background
    if (_isVideo) {
      return (
        <div className="flex-1 min-h-0 bg-black">
          <VideoPlayer src={streamUrl} fileName={fileName} filePath={filePath!} />
        </div>
      );
    }

    // PDF — full iframe
    if (_isPdf) {
      return (
        <div className="flex-1 min-h-0">
          <PDFPreview streamUrl={streamUrl} fileName={fileName} />
        </div>
      );
    }

    // Image — fill preview area, maintain aspect ratio
    if (_isImage) {
      return (
        <div className="flex-1 min-h-0 p-4 bg-black/30">
          <ImagePreview
            downloadUrl={downloadUrl}
            fileName={fileName}
            svgSource={_isSvg ? file?.content : undefined}
            thumbnailUrl={thumbnailUrl}
          />
        </div>
      );
    }

    // Audio — centered player
    if (_isAudio) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <div className="w-full max-w-sm">
            <AudioPlayer
              src={streamUrl}
              fileName={fileName}
              fileIcon={icon}
              fileIconColor={color}
            />
          </div>
        </div>
      );
    }

    // Text-based: code, markdown, plain text
    return (
      <ScrollArea className="flex-1 min-h-0">
        {isLoading && shouldFetch ? (
          <div className="space-y-2 p-6">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : _isMd && file?.content ? (
          <MarkdownPreview content={file.content} />
        ) : _isCode && file?.content ? (
          <CodePreview code={file.content} filePath={filePath} />
        ) : file?.content ? (
          <pre className="text-xs leading-relaxed font-mono whitespace-pre-wrap break-words p-6 text-muted-foreground selection:bg-primary/20">
            {file.content}
          </pre>
        ) : !shouldFetch ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-sm text-muted-foreground">No preview available for this file type.</p>
          </div>
        ) : null}
      </ScrollArea>
    );
  };

  return (
    <Dialog open={!!filePath} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 overflow-hidden w-[calc(100vw-1.5rem)] h-[calc(100svh-1.5rem)] max-w-none! sm:max-w-none! flex flex-col rounded-xl sm:w-[calc(100vw-2.5rem)] sm:h-[calc(100svh-2.5rem)]"
      >
        <DialogTitle className="sr-only">
          {fileName || "File Preview"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Preview and download the selected file
        </DialogDescription>

        {/* ── Header bar ──────────────────────────────────────────────── */}
        <div className="flex h-12 items-center gap-2 px-3 border-b border-border shrink-0">
          <div className={cn("flex items-center justify-center size-7 rounded-md bg-muted/50 shrink-0", color)}>
            <HugeiconsIcon icon={icon} size={14} />
          </div>
          <span className="font-medium text-sm text-muted-foreground truncate">
            {file?.name || fileName}
          </span>
          {file && (
            <span className="text-xs text-muted-foreground font-mono truncate hidden sm:block">
              {formatBytes(file.size)}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1 shrink-0">
            {previewableFiles.length > 1 && (
              <div className="flex items-center gap-0.5 mr-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground disabled:text-dim-foreground disabled:pointer-events-none phone-touch:size-11"
                  onClick={goToPrev}
                  disabled={!hasPrev}
                  aria-label="Previous file"
                >
                  <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground min-w-[2.5rem] text-center">
                  {currentIndex + 1} / {previewableFiles.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground disabled:text-dim-foreground disabled:pointer-events-none phone-touch:size-11"
                  onClick={goToNext}
                  disabled={!hasNext}
                  aria-label="Next file"
                >
                  <HugeiconsIcon icon={ArrowRight02Icon} size={14} />
                </Button>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground phone-touch:h-11 phone-touch:min-w-11"
              onClick={() => filePath && onDownload(filePath, fileName)}
            >
              <HugeiconsIcon icon={Download01Icon} size={12} aria-hidden="true" />
              {/* Named on phones too, where only the icon shows */}
              <span className="sr-only sm:not-sr-only">Download</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground phone-touch:size-11"
              onClick={onClose}
              aria-label="Close preview"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
            </Button>
          </div>
        </div>

        {/* ── Content area ────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
          {renderContent()}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Move dialog — minimal folder picker ─────────────────────────────────

function MoveDialog({
  open,
  itemCount,
  onClose,
  onMove,
  currentDir,
}: {
  open: boolean;
  itemCount: number;
  onClose: () => void;
  onMove: (destination: string) => void;
  currentDir: string | null;
}) {
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  // Reset browse path when dialog opens
  useEffect(() => {
    if (open) {
      setBrowsePath(currentDir);
      setIsMoving(false);
    }
  }, [open, currentDir]);

  const listUrl = browsePath
    ? `${CORE_URL}/api/files/list?path=${encodeURIComponent(browsePath)}`
    : `${CORE_URL}/api/files/list`;

  const { cache } = useSWRConfig();
  const { data: keptData, error: listError, mutate: retryList, isValidating } = useSWR<ListResponse>(open ? listUrl : null, fetcher, {
    keepPreviousData: true,
  });
  // keepPreviousData keeps the last folder on screen while the next loads. That
  // folder must never pass for the one being browsed: its subfolders and "Move
  // here" would point at the wrong place.
  const dataIsForBrowsePath = listDataIsFor(keptData, browsePath, cache.get(listUrl)?.data !== undefined);
  const data = dataIsForBrowsePath ? keptData : undefined;
  const listFailed = !!listError && !dataIsForBrowsePath;
  const listErrorCopy = listFailed ? folderErrorCopy(fetchErrorStatus(listError), browsePath) : null;
  // The last folder that loaded, so Back after a failed click returns there.
  const [lastLoaded, setLastLoaded] = useState<{ path: string | null } | null>(null);
  if (open && dataIsForBrowsePath && lastLoaded?.path !== browsePath) setLastLoaded({ path: browsePath });
  const backTarget = lastLoaded && lastLoaded.path !== browsePath ? lastLoaded : null;

  const folders = data?.items?.filter((i) => i.isDirectory) ?? [];
  const hasMultipleRoots = ((data ?? keptData)?.allowedRoots?.length ?? 0) > 1;
  const isAtRoot = !browsePath && hasMultipleRoots;

  const handleConfirm = async () => {
    if (!data?.path) return;
    setIsMoving(true);
    onMove(data.path);
  };

  // Back is always offered below the top level, even in a folder with no
  // subfolders (a leaf used to be a dead end).
  const canGoBack = !isAtRoot && !!data?.path && (!!data.parent || hasMultipleRoots);
  const goBack = () => {
    if (!data) return;
    if (hasMultipleRoots && (data.allowedRoots?.includes(data.path) || !data.parent)) {
      setBrowsePath(null);
    } else if (data.parent) {
      setBrowsePath(data.parent);
    }
  };

  // Current folder name for the header (the requested one while it loads or failed)
  const folderName = (data?.path ?? browsePath)?.split("/").filter(Boolean).pop() ?? "Files";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm p-0 gap-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-4 pt-4 pb-3">
          <DialogTitle className="text-sm">
            Move {itemCount} item{itemCount !== 1 ? "s" : ""}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose a destination folder to move the selected items
          </DialogDescription>
        </DialogHeader>

        {/* Breadcrumb bar */}
        {!isAtRoot && (data?.path || browsePath) && (
          <div className="flex items-center gap-1 px-4 pb-2">
            {hasMultipleRoots && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5 rounded phone-touch:min-h-11"
                onClick={() => setBrowsePath(null)}
              >
                Volumes
              </button>
            )}
            {hasMultipleRoots && (
              <span className="text-dim-foreground text-xs">/</span>
            )}
            <span className="text-xs text-muted-foreground font-medium truncate">
              {folderName}
            </span>
          </div>
        )}

        {/* Folder list */}
        <ScrollArea className="h-64 border-t border-border/40">
          {isAtRoot && data?.allowedRoots && !listFailed ? (
            <div className="py-1">
              {data.allowedRoots.map((root: string) => {
                const { label, icon } = rootLabel(root);
                return (
                  <button
                    key={root}
                    type="button"
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left phone-touch:min-h-11 hover:bg-muted/30 transition-colors"
                    onClick={() => setBrowsePath(root)}
                  >
                    <HugeiconsIcon icon={icon} size={16} className="text-dim-foreground shrink-0" />
                    <span className="text-sm truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="py-1">
              {canGoBack && (
                <button
                  type="button"
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left phone-touch:min-h-11 hover:bg-muted/30 transition-colors"
                  onClick={goBack}
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} size={16} className="text-dim-foreground shrink-0" />
                  <span className="text-sm text-muted-foreground">Back</span>
                </button>
              )}
              {listErrorCopy ? (
                <div role="alert" className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                  <p className="text-sm font-medium">{listErrorCopy.title}</p>
                  <p className="text-xs text-muted-foreground">{listErrorCopy.description}</p>
                  <div className="flex items-center gap-2 pt-1">
                    {backTarget ? (
                      <Button variant="ghost" size="xs" onClick={() => setBrowsePath(backTarget.path)}>Back</Button>
                    ) : null}
                    <Button variant="outline" size="xs" onClick={() => void retryList()} busy={isValidating} busyLabel="Retrying…">
                      Retry
                    </Button>
                  </div>
                </div>
              ) : !data ? (
                <div className="h-24" aria-busy="true" />
              ) : folders.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">No subfolders</p>
              ) : null}
              {folders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left phone-touch:min-h-11 hover:bg-muted/30 transition-colors group"
                  onClick={() => setBrowsePath(folder.path)}
                >
                  <HugeiconsIcon icon={Folder01Icon} size={16} className="text-muted-foreground shrink-0" />
                  <span className="text-sm truncate flex-1">{folder.name}</span>
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    size={14}
                    className="text-dim-foreground group-hover:text-muted-foreground shrink-0 transition-colors"
                  />
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <DialogFooter className="border-t border-border/40 px-4 py-3">
          <Button variant="ghost" size="sm" className="phone-touch:h-11" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            className="phone-touch:h-11"
            onClick={() => void handleConfirm()}
            disabled={isAtRoot || isMoving || !data?.path}
          >
            {isMoving ? "Moving…" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Row actions (shared by the "…" menu and the right-click menu) ─────────

function FileRowActionItems({
  menu,
  item,
  onOpen,
  onRename,
  onMove,
  onDownload,
  onDelete,
  pinned,
  onTogglePin,
}: {
  menu: "dropdown" | "context";
  item: FileItem;
  onOpen: (item: FileItem) => void;
  onRename: (item: FileItem) => void;
  onMove: (item: FileItem) => void;
  onDownload: (path: string, name: string) => void;
  onDelete: (item: FileItem) => void;
  /** Folders only, in a desktop window: pin to or unpin from the sidebar */
  pinned?: boolean;
  onTogglePin?: (item: FileItem) => void;
}) {
  const actions: { id: string; label: string; icon: IconSvgElement; run: () => void; destructive?: boolean; separatorBefore?: boolean }[] = [
    ...(item.isDirectory || isPreviewable(item.name)
      ? [{ id: "open", label: item.isDirectory ? "Open" : "Quick Look", icon: item.isDirectory ? FolderOpenIcon : FileAttachmentIcon, run: () => onOpen(item) }]
      : []),
    ...(item.isDirectory && onTogglePin
      ? [{ id: "pin", label: pinned ? "Remove from sidebar" : "Add to sidebar", icon: pinned ? PinOffIcon : PinIcon, run: () => onTogglePin(item) }]
      : []),
    { id: "rename", label: "Rename", icon: Edit02Icon, run: () => onRename(item) },
    { id: "move", label: "Move to…", icon: FolderExportIcon, run: () => onMove(item) },
    ...(!item.isDirectory ? [{ id: "download", label: "Download", icon: Download01Icon, run: () => onDownload(item.path, item.name) }] : []),
    { id: "delete", label: "Delete permanently…", icon: Delete01Icon, destructive: true, separatorBefore: true, run: () => onDelete(item) },
  ];
  const Item = menu === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator = menu === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;

  return (
    <>
      {actions.map((action) => (
        <Fragment key={action.id}>
          {action.separatorBefore && <Separator />}
          <Item
            variant={action.destructive ? "destructive" : undefined}
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              action.run();
            }}
          >
            <HugeiconsIcon icon={action.icon} size={14} />
            {action.label}
          </Item>
        </Fragment>
      ))}
    </>
  );
}

// ── Page component ──────────────────────────────────────────────────────

const NO_ITEMS: FileItem[] = [];

interface NavigateOptions {
  /** Select and scroll to this item once the folder has loaded */
  reveal?: string;
  /** Keep searching for this, below the new folder (otherwise opening a folder ends the search) */
  search?: string;
}

function FilesPageInner({
  initialPath,
  initialReveal = null,
  initialQuery = null,
}: {
  initialPath: string | null;
  /** ?reveal=<name>: select this item when the folder opens ("Show in folder") */
  initialReveal?: string | null;
  /** ?q=<query>: open with a search below the folder */
  initialQuery?: string | null;
}) {
  const router = useRouter();
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [renamingItem, setRenamingItem] = useState<FileItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // A dotfile shown from search results is only listed with hidden files on.
  const [showHidden, setShowHidden] = useState(() => initialReveal?.startsWith(".") ?? false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  /** A row that was just created or revealed, highlighted for a moment */
  const [highlightedName, setHighlightedName] = useState<string | null>(null);
  const [pendingReveal, setPendingReveal] = useState<string | null>(initialReveal);
  const [movingPaths, setMovingPaths] = useState<string[]>([]);
  // Search: typing filters this folder; Enter or "Include subfolders" searches below it.
  const [query, setQuery] = useState(initialQuery ?? "");
  const [scopeChoice, setScopeChoice] = useState<FilesSearchScope>(initialQuery ? "deep" : "folder");
  /** The table row that takes Tab (roving focus) */
  const [activeRowPath, setActiveRowPath] = useState<string | null>(null);
  const confirm = useConfirm();
  const scrollPositions = useRef<Map<string, number>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsListRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const lastSelectedIdx = useRef<number | null>(null);
  const setPageAction = useSetAtom(pageActionAtom);
  const setPageTitle = useSetAtom(pageTitleAtom);
  const setPageBack = useSetAtom(pageBackAtom);

  // When currentPath is null, we fetch the default root to get allowedRoots
  const listUrl = currentPath
    ? `${CORE_URL}/api/files/list?path=${encodeURIComponent(currentPath)}&showHidden=${showHidden}`
    : `${CORE_URL}/api/files/list?showHidden=${showHidden}`;

  const { loadedAt: listLoadedAt, markLoaded } = useLoadedAt();
  const { cache: swrCache } = useSWRConfig();
  const { data, error, mutate, isLoading, isValidating } = useSWR<ListResponse>(listUrl, fetcher, {
    keepPreviousData: true,
    onSuccess: markLoaded,
    // "Doesn't exist" and "no permission" are answers, not blips.
    shouldRetryOnError: (err: unknown) => {
      const status = fetchErrorStatus(err);
      return status === null || status >= 500;
    },
  });
  // keepPreviousData shows the last folder while the next one loads. When the
  // next one fails, that old listing must not pass for this folder's. The
  // server returns a normalized path, so compare by SWR key (the cache holds
  // data for this exact request) or by normalized path, never byte for byte.
  const dataIsForThisFolder = listDataIsFor(data, currentPath, swrCache.get(listUrl)?.data !== undefined);
  // Driven by "this folder's data isn't here yet", so opening a folder with the
  // previous one still on screen gets the delayed skeleton too (spec §4.8).
  const loadingPhase = useLoadingPhase(!dataIsForThisFolder && !error && (isLoading || isValidating));

  // In a desktop window, a Finder-style sidebar lists pinned folders and every location
  const embedded = useIsEmbeddedFrame();
  const favoriteFolders = useFileFavorites(embedded ? data?.allowedRoots?.[0] : undefined);

  // Only auto-enter a root when there's exactly one
  const hasMultipleRoots = (data?.allowedRoots?.length ?? 0) > 1;
  const isAtVirtualRoot = !currentPath && hasMultipleRoots;

  useEffect(() => {
    if (data?.path && !currentPath && !hasMultipleRoots) setCurrentPath(data.path);
  }, [data, currentPath, hasMultipleRoots]);

  // Restore saved scroll position on navigation
  useLayoutEffect(() => {
    const scrollParent = contentRef.current;
    if (!scrollParent) return;
    const key = currentPath ?? "root-view";
    const saved = scrollPositions.current.get(key);
    scrollParent.scrollTo({ top: saved ?? 0 });
  }, [currentPath]);

  // ── Search ──────────────────────────────────────────────────────────

  const trimmedQuery = query.trim();
  // At the list of locations there's no folder to filter: search goes everywhere.
  const scope: FilesSearchScope = isAtVirtualRoot ? "deep" : scopeChoice;
  const deepSearch = trimmedQuery.length > 0 && scope === "deep";
  const folderFilter = trimmedQuery.length > 0 && scope === "folder";
  const listItems = data?.items ?? NO_ITEMS;
  /** The rows on screen: selection, select-all, Quick Look and downloads act on these only */
  const visibleItems = useMemo(
    () => (deepSearch ? NO_ITEMS : folderFilter ? filterByQuery(listItems, trimmedQuery) : listItems),
    [deepSearch, folderFilter, listItems, trimmedQuery],
  );
  const selectedVisible = useMemo(() => {
    if (selectedPaths.size === 0) return selectedPaths;
    return new Set(visibleItems.filter((item) => selectedPaths.has(item.path)).map((item) => item.path));
  }, [selectedPaths, visibleItems]);

  // Locations with their labels, and the folder's path read from its location
  const knownRoots = useMemo(
    () => data?.roots?.map((root) => ({ path: root.path, label: root.label }))
      ?? (data?.allowedRoots ?? []).map((root) => ({ path: root, label: rootLabel(root).label })),
    [data?.roots, data?.allowedRoots],
  );
  const shownPath = isAtVirtualRoot ? null : dataIsForThisFolder ? (data?.path ?? currentPath) : (currentPath ?? data?.path ?? null);
  const segments = useMemo(() => displaySegments(shownPath, knownRoots), [shownPath, knownRoots]);
  const folderLabel = segments.length > 0 ? segments[segments.length - 1].name : "Files";
  const locationLabel = isAtVirtualRoot ? "all locations" : folderLabel;

  const search = useFileSearch({
    enabled: deepSearch,
    path: isAtVirtualRoot ? null : shownPath,
    query: trimmedQuery,
    showHidden,
    locationName: locationLabel,
  });
  const { cancel: cancelSearch, runNow: runSearchNow } = search;

  /** Keeps only selected items that are still on screen after the search changes */
  const pruneSelection = useCallback((nextQuery: string, nextScope: FilesSearchScope) => {
    setSelectedPaths((prev) => {
      if (prev.size === 0) return prev;
      const trimmed = nextQuery.trim();
      const deep = trimmed.length > 0 && (isAtVirtualRoot || nextScope === "deep");
      if (deep) return new Set();
      const visible = new Set(filterByQuery(listItems, trimmed).map((item) => item.path));
      const next = new Set([...prev].filter((path) => visible.has(path)));
      return next.size === prev.size ? prev : next;
    });
    lastSelectedIdx.current = null;
  }, [isAtVirtualRoot, listItems]);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    pruneSelection(next, scopeChoice);
  }, [pruneSelection, scopeChoice]);

  const changeScope = useCallback((next: FilesSearchScope) => {
    setScopeChoice(next);
    pruneSelection(query, next);
    if (next === "deep") runSearchNow();
  }, [pruneSelection, query, runSearchNow]);

  const clearSearch = useCallback(() => {
    cancelSearch();
    setQuery("");
    setScopeChoice("folder");
  }, [cancelSearch]);

  const hasSelection = selectedVisible.size > 0;
  const reduceMotion = useReducedMotion();

  // Into a folder the list arrives from the right; back out, from the left
  const [navDirection, setNavDirection] = useState(0);
  const navigate = useCallback((path: string, options: NavigateOptions = {}) => {
    setNavDirection(
      !currentPath || path.startsWith(`${currentPath}/`) ? 1 : currentPath.startsWith(`${path}/`) ? -1 : 0,
    );
    // Save scroll position of current view
    const scrollParent = contentRef.current;
    if (scrollParent) {
      const key = currentPath ?? "root-view";
      scrollPositions.current.set(key, scrollParent.scrollTop);
    }
    setCurrentPath(path);
    setSelectedPaths(new Set());
    lastSelectedIdx.current = null;
    setActiveRowPath(null);
    // Opening a folder ends a search, unless the search moves with it.
    cancelSearch();
    setQuery(options.search ?? "");
    setScopeChoice(options.search ? "deep" : "folder");
    setPendingReveal(options.reveal ?? null);
    if (options.reveal?.startsWith(".")) setShowHidden(true);
    // Update title atomically to prevent blink
    const isRoot = data?.allowedRoots?.includes(path);
    const folderName = isRoot
      ? rootLabel(path).label
      : path.split("/").filter(Boolean).pop() || "Files";
    setPageTitle(folderName);
    let url = `/dashboard/files?path=${encodeURIComponent(path)}`;
    if (options.reveal) url += `&reveal=${encodeURIComponent(options.reveal)}`;
    if (options.search) url += `&q=${encodeURIComponent(options.search)}`;
    router.replace(url, { scroll: false });
  }, [currentPath, router, data?.allowedRoots, setPageTitle, cancelSearch]);

  const handleDownload = useCallback((filePath: string, fileName: string) => {
    const a = document.createElement("a");
    a.href = `${CORE_URL}/api/files/download?path=${encodeURIComponent(filePath)}`;
    a.download = fileName;
    a.click();
  }, []);

  /** Delete one path. Resolves on success; rejects with a message that names the item. */
  const deletePath = useCallback(async (filePath: string, fileName: string) => {
    let res: Response;
    try {
      res = await fetch(`${CORE_URL}/api/files`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath }),
      });
    } catch {
      throw new Error(`Couldn't delete ${fileName}: the Talome server didn't answer. Retry.`);
    }
    const result = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !result?.ok) {
      throw new Error(`Couldn't delete ${fileName}${result?.error ? `: ${result.error}` : ""}.`);
    }
  }, []);

  /**
   * Deleting is permanent (there is no Trash yet), so every delete, a single
   * file included, asks first. The dialog runs the request and shows a
   * failure inline with Retry.
   */
  const confirmDelete = useCallback(async (item: FileItem) => {
    const where = rootLabel(currentPath ?? item.path).label;
    await confirm({
      tier: "destructive",
      title: `Delete ${item.name} permanently?`,
      consequence: item.isDirectory
        ? `${item.name} and everything in it are erased from ${where}.`
        : `${item.name} is erased from ${where}.`,
      recovery: "This can't be undone.",
      irreversible: true,
      confirmLabel: "Delete permanently",
      busyLabel: `Deleting ${item.name}…`,
      run: async () => {
        await deletePath(item.path, item.name);
        setSelectedPaths((prev) => {
          if (!prev.has(item.path)) return prev;
          const next = new Set(prev);
          next.delete(item.path);
          return next;
        });
        await mutate();
      },
      receipt: `Deleted ${item.name}`,
    });
  }, [confirm, currentPath, deletePath, mutate]);

  const handleRename = useCallback(async () => {
    const newName = renameValue.trim();
    if (!renamingItem || !newName || newName === renamingItem.name) {
      setRenamingItem(null);
      return;
    }
    let result: { ok?: boolean; error?: string } | null = null;
    let ok = false;
    try {
      const res = await fetch(`${CORE_URL}/api/files/rename`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath: renamingItem.path, newName }),
      });
      result = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      ok = res.ok && !!result?.ok;
    } catch {
      result = { error: "the Talome server didn't answer" };
    }
    if (ok) {
      void mutate();
      setRenamingItem(null);
    } else {
      // Keep the dialog open so the name can be fixed (for example a name that's taken).
      toast.error(`Couldn't rename ${renamingItem.name}`, { description: result?.error ?? "Retry in a moment." });
    }
  }, [renamingItem, renameValue, mutate]);

  const handleNewFolder = useCallback(async () => {
    if (!currentPath) return;
    // The new folder must be on screen to be named.
    clearSearch();
    const existing = (data?.items ?? []).map((item) => item.name);
    // A free name ("New Folder 2", …) instead of silently reusing "New Folder".
    // The server also refuses an existing name, so a race (or a hidden item)
    // gets one more try with the next free name.
    let name = uniqueName("New Folder", existing);
    for (let attempt = 0; attempt < 2; attempt++) {
      let status = 0;
      let result: { ok?: boolean; error?: string } | null = null;
      try {
        const res = await fetch(`${CORE_URL}/api/files/mkdir`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `${currentPath}/${name}` }),
        });
        status = res.status;
        result = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      } catch {
        toast.error("Couldn't create a folder", { description: "The Talome server didn't answer. Retry." });
        return;
      }
      if (result?.ok) {
        setHighlightedName(name);
        await mutate();
        if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
        highlightTimer.current = window.setTimeout(() => setHighlightedName(null), 2000);
        // Name it right away, like a desktop file manager.
        setRenamingItem({ name, path: `${currentPath}/${name}`, isDirectory: true, size: 0, modified: null });
        setRenameValue(name);
        return;
      }
      if (status !== 409) {
        toast.error("Couldn't create a folder", { description: result?.error ?? "Retry in a moment." });
        return;
      }
      name = uniqueName("New Folder", [...existing, name]);
      existing.push(name);
    }
    toast.error("Couldn't create a folder", { description: "A folder with that name already exists. Refresh and try again." });
  }, [currentPath, data?.items, mutate, clearSearch]);

  // Refresh the listing as uploads land, at most twice a second
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshAfterUpload = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void mutate();
    }, 500);
  }, [mutate]);
  const uploads = useUploadQueue(refreshAfterUpload);

  const addUploads = uploads.add;
  const handleUpload = useCallback((files: PendingFile[]) => {
    if (!currentPath || files.length === 0) return;
    addUploads(files, currentPath);
  }, [currentPath, addUploads]);

  const handleRowClick = useCallback((item: FileItem) => {
    if (item.isDirectory) {
      navigate(item.path);
    } else if (isPreviewable(item.name)) {
      // Every previewable file opens Quick Look; text over the 5MB limit
      // opens a "Too large" preview with Download (it used to do nothing).
      setPreviewFile(item.path);
    }
  }, [navigate]);

  const renameItem = useCallback((item: FileItem) => {
    setRenamingItem(item);
    setRenameValue(item.name);
  }, []);
  const moveItem = useCallback((item: FileItem) => setMovingPaths([item.path]), []);
  // Every delete asks first (permanent: there is no Trash yet).
  const deleteItem = useCallback((item: FileItem) => {
    void confirmDelete(item);
  }, [confirmDelete]);


  // ── Multi-select ──────────────────────────────────────────────────────

  // Indexes are into the rows on screen, so a shift-range never takes in rows a filter hides.
  const toggleSelect = useCallback((path: string, idx: number, shiftKey: boolean) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedIdx.current !== null) {
        const start = Math.min(lastSelectedIdx.current, idx);
        const end = Math.max(lastSelectedIdx.current, idx);
        for (let i = start; i <= end; i++) {
          const item = visibleItems[i];
          if (item) next.add(item.path);
        }
      } else {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      }
      return next;
    });
    lastSelectedIdx.current = idx;
  }, [visibleItems]);

  const allSelected = visibleItems.length > 0 && visibleItems.every(item => selectedPaths.has(item.path));

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(visibleItems.map(i => i.path)));
    }
    lastSelectedIdx.current = null;
  }, [visibleItems, allSelected]);

  const confirmBulkDelete = useCallback(async () => {
    const paths = Array.from(selectedVisible);
    if (paths.length === 0) return;
    const items = paths.map((path) => data?.items?.find((i) => i.path === path) ?? { name: path.split("/").pop() ?? path, path });
    const first = items[0].name;
    const count = items.length;
    const where = rootLabel(currentPath ?? paths[0]).label;
    await confirm({
      tier: "destructive",
      title: `Delete ${count} item${count === 1 ? "" : "s"} permanently?`,
      consequence: count === 1
        ? `${first} is erased from ${where}.`
        : `${first} and ${count - 1} other item${count - 1 === 1 ? "" : "s"} are erased from ${where}, with everything inside any folders.`,
      recovery: "This can't be undone.",
      irreversible: true,
      confirmLabel: "Delete permanently",
      busyLabel: `Deleting ${count} item${count === 1 ? "" : "s"}…`,
      run: async () => {
        const results = await Promise.allSettled(items.map((item) => deletePath(item.path, item.name)));
        const failed = items.filter((_, i) => results[i].status === "rejected");
        const deleted = new Set(items.filter((_, i) => results[i].status === "fulfilled").map((item) => item.path));
        setSelectedPaths((prev) => new Set([...prev].filter((p) => !deleted.has(p))));
        lastSelectedIdx.current = null;
        await mutate();
        if (failed.length > 0) {
          // What's left selected is what failed: Retry deletes only those.
          throw new Error(
            `Couldn't delete ${failed.length === 1 ? failed[0].name : `${failed.length} items`}${deleted.size > 0 ? ` (${deleted.size} deleted)` : ""}. Retry, or check that Talome may write here.`,
          );
        }
        return deleted.size;
      },
      receipt: (n) => `Deleted ${n} item${n === 1 ? "" : "s"}`,
    });
  }, [confirm, currentPath, data?.items, deletePath, mutate, selectedVisible]);

  const handleBulkDownload = useCallback(() => {
    for (const item of visibleItems) {
      if (selectedVisible.has(item.path) && !item.isDirectory) {
        handleDownload(item.path, item.name);
      }
    }
  }, [selectedVisible, visibleItems, handleDownload]);

  const handleMove = useCallback(async (destination: string) => {
    const sources = movingPaths;
    if (sources.length === 0) return;

    type MoveResult = { moved?: string[]; errors?: Array<{ error: string }>; error?: string };
    let result: MoveResult | null = null;
    try {
      const res = await fetch(`${CORE_URL}/api/files/move`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources, destination }),
      });
      result = (await res.json().catch(() => null)) as MoveResult | null;
      if (!res.ok && !result?.moved) {
        toast.error("Couldn't move the selection", { description: result?.error ?? "Retry in a moment." });
        setMovingPaths([]);
        return;
      }
    } catch {
      toast.error("Couldn't move the selection", { description: "The Talome server didn't answer. Retry." });
      setMovingPaths([]);
      return;
    }
    const moved = result?.moved ?? [];
    if (moved.length > 0) {
      const target = destination.split("/").filter(Boolean).pop() ?? destination;
      toast.success(`Moved ${moved.length === 1 ? moved[0].split("/").pop() : `${moved.length} items`} to ${target}`);
      setSelectedPaths(new Set());
      lastSelectedIdx.current = null;
      void mutate();
    }
    if (result?.errors && result.errors.length > 0) {
      toast.error(`Couldn't move ${result.errors.length === 1 ? "1 item" : `${result.errors.length} items`}`, { description: result.errors[0].error });
    }
    setMovingPaths([]);
  }, [movingPaths, mutate]);

  // ── Drag & drop ─────────────────────────────────────────────────────

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.items.length > 0 || e.dataTransfer.files.length > 0) {
      // Folders dropped here upload with their structure intact
      void filesFromDrop(e.dataTransfer).then(handleUpload);
    }
  }, [handleUpload]);

  // ── Header actions ──────────────────────────────────────────────────

  const canGoBack = isAtVirtualRoot ? false : !!data?.parent || hasMultipleRoots;
  const goToVirtualRoot = useCallback(() => {
    const scrollParent = contentRef.current;
    if (scrollParent) {
      const key = currentPath ?? "root-view";
      scrollPositions.current.set(key, scrollParent.scrollTop);
    }
    setCurrentPath(null);
    setPageTitle(null);
    setPageBack(null);
    router.replace("/dashboard/files", { scroll: false });
  }, [currentPath, router, setPageTitle, setPageBack]);

  const goBack = useCallback(() => {
    if (hasMultipleRoots && data?.parent && !data.allowedRoots.some((r: string) => data.parent === r || data.parent?.startsWith(r + "/"))) {
      goToVirtualRoot();
    } else if (hasMultipleRoots && data?.path && data.allowedRoots.includes(data.path)) {
      goToVirtualRoot();
    } else if (data?.parent) {
      navigate(data.parent);
    }
  }, [data?.parent, data?.path, data?.allowedRoots, hasMultipleRoots, navigate, goToVirtualRoot]);

  // Escape to clear selection (Escape in the search field clears the search instead)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target === searchInputRef.current) return;
      if (e.key === "Escape" && selectedPaths.size > 0) {
        setSelectedPaths(new Set());
        lastSelectedIdx.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPaths.size]);

  // The folder's verbs: in classic mode in the page header, in a window at the
  // trailing end of the toolbar (the title bar keeps only Back and the title).
  // At the list of locations there's no folder to upload into.
  const toolbarActions = !embedded || isAtVirtualRoot ? null : (
    <FilesActions
      placement="toolbar"
      onUploadFiles={() => fileInputRef.current?.click()}
      onUploadFolder={() => folderInputRef.current?.click()}
      onNewFolder={() => void handleNewFolder()}
    />
  );
  useEffect(() => {
    if (embedded || isAtVirtualRoot) {
      setPageAction(null);
      return;
    }
    setPageAction(
      // The header row is title-first: the verbs sit at its trailing end, like
      // every other page action (site-header renders this in its flex row as is)
      <div data-files-actions="" className="ml-auto flex shrink-0 items-center gap-1">
        <FilesActions
          placement="header"
          onUploadFiles={() => fileInputRef.current?.click()}
          onUploadFolder={() => folderInputRef.current?.click()}
          onNewFolder={() => void handleNewFolder()}
        />
      </div>,
    );
    return () => setPageAction(null);
  }, [setPageAction, handleNewFolder, isAtVirtualRoot, embedded]);

  // Wire atom-based drilldown: show folder name + back button in header.
  // Uses useLayoutEffect + currentPath (not data?.path) so the title is set
  // before paint — prevents the "Files" default label from flashing.
  useLayoutEffect(() => {
    if (currentPath) {
      const isRoot = data?.allowedRoots?.includes(currentPath);
      const folderName = isRoot
        ? rootLabel(currentPath).label
        : currentPath.split("/").filter(Boolean).pop() || "Files";
      setPageTitle(folderName);
      setPageBack(() => goBack);
    } else {
      setPageTitle(null);
      setPageBack(null);
    }
    return () => {
      setPageTitle(null);
      setPageBack(null);
    };
  }, [currentPath, hasMultipleRoots, data?.allowedRoots, goBack, setPageTitle, setPageBack]);

  // ── Reveal ("Show in folder") ───────────────────────────────────────

  const hasDataForKey = swrCache.get(listUrl)?.data !== undefined;
  const [revealed, setRevealed] = useState<{ path: string; index: number } | null>(null);
  // Once this exact listing is here (hidden files may just have been turned
  // on), select the item; the effect below scrolls to it.
  if (pendingReveal && !deepSearch && dataIsForThisFolder && hasDataForKey && data?.items) {
    const index = data.items.findIndex((entry) => entry.name === pendingReveal);
    setPendingReveal(null);
    if (index >= 0) {
      const item = data.items[index];
      setSelectedPaths(new Set([item.path]));
      setActiveRowPath(item.path);
      setHighlightedName(item.name);
      setRevealed({ path: item.path, index });
    }
  }

  useEffect(() => {
    if (!revealed) return;
    lastSelectedIdx.current = revealed.index;
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightedName(null), 2000);
    const frame = window.requestAnimationFrame(() => {
      const row = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-file-path]") ?? [])
        .find((element) => element.dataset.filePath === revealed.path);
      row?.scrollIntoView?.({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [revealed, reduceMotion]);

  useEffect(() => () => {
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
  }, []);

  /** Shows a search result in its folder, selected: here if it's in this folder, otherwise there. */
  const showInFolder = useCallback((item: FileItem) => {
    const folder = parentPath(item.path);
    if (!isAtVirtualRoot && shownPath && samePath(folder, shownPath)) {
      clearSearch();
      if (item.name.startsWith(".")) setShowHidden(true);
      setPendingReveal(item.name);
      return;
    }
    navigate(folder, { reveal: item.name });
  }, [isAtVirtualRoot, shownPath, clearSearch, navigate]);

  const openSearchResult = useCallback((item: FileItem) => {
    if (item.isDirectory) navigate(item.path);
    else if (isPreviewable(item.name)) setPreviewFile(item.path);
    else showInFolder(item);
  }, [navigate, showInFolder]);

  // ── Keyboard ────────────────────────────────────────────────────────

  const dialogOpen = !!previewFile || !!renamingItem || movingPaths.length > 0;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SHORTCUTS.filesSearch.matches(event)) return;
      const field = searchInputRef.current;
      if (!field) return;
      // Pressed again in the field: the browser's own find takes it.
      if (document.activeElement === field) return;
      if (dialogOpen || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialogOpen]);

  const tableRows = useCallback(
    () => Array.from(contentRef.current?.querySelectorAll<HTMLElement>("tr[data-file-path]") ?? []),
    [],
  );
  const focusTableRow = useCallback((index: number) => {
    const rows = tableRows();
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setActiveRowPath(row.dataset.filePath ?? null);
    row.focus();
  }, [tableRows]);

  const focusSearchField = useCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, []);

  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        // First Escape clears the search, the next leaves the field.
        if (query) clearSearch();
        else event.currentTarget.blur();
        break;
      case "Enter": {
        event.preventDefault();
        if (!trimmedQuery) return;
        if (!deepSearch) {
          changeScope("deep");
          return;
        }
        const first = search.result?.items[0];
        if (first && !search.stale && !search.error) openSearchResult(first);
        else runSearchNow();
        break;
      }
      case "ArrowDown": {
        event.preventDefault();
        if (deepSearch) {
          resultsListRef.current?.querySelector<HTMLElement>('[data-search-result="name"]')?.focus();
        } else {
          focusTableRow(0);
        }
        break;
      }
      default:
        break;
    }
  };

  const onTableRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, item: FileItem, index: number) => {
    // Keys in the row's own buttons and menus belong to them.
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusTableRow(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (index === 0) focusSearchField();
        else focusTableRow(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusTableRow(0);
        break;
      case "End":
        event.preventDefault();
        focusTableRow(visibleItems.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        handleRowClick(item);
        break;
      case " ":
        event.preventDefault();
        toggleSelect(item.path, index, event.shiftKey);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        focusSearchField();
        break;
      default:
        break;
    }
  };

  // ── What the column shows ───────────────────────────────────────────

  const folderError = !!error && !dataIsForThisFolder;
  const uploadFiles = () => fileInputRef.current?.click();
  const searchSubfolders = () => changeScope("deep");
  const rovingRowPath = visibleItems.some((item) => item.path === activeRowPath) ? activeRowPath : visibleItems[0]?.path ?? null;

  let countLabel: string | null = null;
  if (deepSearch) {
    if (search.result && !search.stale && !search.error) {
      countLabel = filesCountLabel({ kind: "results", count: search.result.items.length, truncated: search.result.truncated });
    }
  } else if (!isAtVirtualRoot && dataIsForThisFolder && data?.items) {
    countLabel = folderFilter
      ? filesCountLabel({ kind: "filtered", shown: visibleItems.length, total: data.items.length })
      : filesCountLabel({ kind: "folder", total: data.items.length });
  }

  type BodyKind = "error" | "search" | "wait" | "table-skeleton" | "roots-skeleton" | "roots" | "empty" | "no-matches" | "table";
  const bodyKind: BodyKind = folderError
    ? "error"
    : deepSearch
      ? "search"
      : loadingPhase === "skeleton" || !data
        ? loadingPhase !== "skeleton" ? "wait" : currentPath ? "table-skeleton" : "roots-skeleton"
        : isAtVirtualRoot && data.allowedRoots
          ? "roots"
          : !data.items
            ? "wait"
            : data.items.length === 0
              ? "empty"
              : visibleItems.length === 0
                ? "no-matches"
                : "table";
  const showListHeader = bodyKind === "table" || bodyKind === "table-skeleton";
  // The results grid is on screen (FileSearchResults renders it exactly then),
  // so the search field may point at it.
  const resultsShown = bodyKind === "search"
    && trimmedQuery.length >= SEARCH_MIN_CHARS
    && !!search.result
    && !search.error
    && search.result.items.length > 0;
  // The rootmost folder of this one, for "Search all of Talome Files"
  const rootSegment = segments.length > 1 ? segments[0] : null;

  const renderBody = () => {
    switch (bodyKind) {
      case "error": {
        const copy = folderErrorCopy(fetchErrorStatus(error), currentPath);
        return (
          <div className="flex flex-1 flex-col items-center justify-center pb-12">
            <ErrorState fill title={copy.title} description={copy.description} onRetry={() => void mutate()} className="min-h-0 flex-none pb-3" />
            {currentPath && (
              <Button variant="ghost" size="sm" onClick={goToVirtualRoot}>
                Back to Files
              </Button>
            )}
          </div>
        );
      }
      case "search":
        return (
          <FileSearchResults
            search={search}
            query={trimmedQuery}
            locationLabel={locationLabel}
            everywhere={isAtVirtualRoot}
            roots={knownRoots}
            showHidden={showHidden}
            widen={rootSegment ? { label: `Search all of ${rootSegment.name}`, onSelect: () => navigate(rootSegment.path, { search: trimmedQuery }) } : null}
            onIncludeHidden={() => setShowHidden(true)}
            onOpen={openSearchResult}
            onShowInFolder={showInFolder}
            onDownload={(item) => handleDownload(item.path, item.name)}
            onExitToField={focusSearchField}
            listRef={resultsListRef}
          />
        );
      case "wait":
        return <div className="min-h-64 flex-1" aria-busy="true" />;
      case "table-skeleton":
        return <FilesTableSkeleton />;
      case "roots-skeleton":
        return (
          <div className="mx-auto flex w-full max-w-lg flex-col gap-3 px-[var(--window-pad,0.75rem)] pt-2" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-xl border px-4 py-3.5">
                <Skeleton className="size-8 rounded-lg shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-1 w-full" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            ))}
          </div>
        );
      case "roots":
        return (
          <RootsList
            roots={getVisibleFileRoots(
              data?.roots ?? (data?.allowedRoots ?? []).map((root) => ({
                id: root,
                path: root,
                label: rootLabel(root).label,
                kind: root.includes(".talome/files") ? "talome-files" : "external",
              })),
              { keepTalomeFallback: true },
            )}
            onSelect={(root) => navigate(root)}
          />
        );
      case "empty":
        return (
          <EmptyState
            fill
            icon={FolderOpenIcon}
            title="This folder is empty"
            description="Drop files here, or upload them."
            action={
              <Button variant="outline" size="sm" className="phone-touch:h-11" onClick={uploadFiles}>
                <HugeiconsIcon icon={CloudUploadIcon} size={14} />
                Upload files
              </Button>
            }
          />
        );
      case "no-matches":
        return (
          <EmptyState
            fill
            icon={Search01Icon}
            title={`Nothing in ${folderLabel} matches “${trimmedQuery}”`}
            description={`Search its subfolders to look further down.${showHidden ? "" : " Hidden files aren't shown."}`}
            action={
              <Button variant="outline" size="sm" onClick={searchSubfolders}>
                Search subfolders
              </Button>
            }
          />
        );
      case "table":
        return (
          <>
            <Table className="table-fixed" containerClassName="overflow-visible">
              <FilesColGroup />
              <TableBody>
                {visibleItems.map((item, idx) => {
                  const { icon, color } = fileIcon(item);
                  const clickable = item.isDirectory || isPreviewable(item.name);
                  const isSelected = selectedPaths.has(item.path);
                  const isHighlighted = item.name === highlightedName;

                  return (
                    <ContextMenu key={item.path}>
                      <ContextMenuTrigger asChild>
                      <TableRow
                        data-file-path={item.path}
                        tabIndex={item.path === rovingRowPath ? 0 : -1}
                        aria-selected={isSelected}
                        className={cn(
                          "group h-10 border-transparent transition-colors phone-touch:h-11",
                          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                          clickable && "cursor-pointer",
                          isSelected && "bg-muted/60",
                        )}
                        style={isHighlighted ? { animation: "folder-highlight 2s ease-out" } : undefined}
                        onClick={() => handleRowClick(item)}
                        onFocus={(event) => {
                          if (event.target === event.currentTarget) setActiveRowPath(item.path);
                        }}
                        onKeyDown={(event) => onTableRowKeyDown(event, item, idx)}
                      >
                        <TableCell className={FILES_FIRST_CELL}>
                          <div className="flex items-center justify-center">
                            <button
                              type="button"
                              tabIndex={-1}
                              aria-label={isSelected ? `Deselect ${item.name}` : `Select ${item.name}`}
                              className={cn(
                                "flex items-center justify-center rounded-full transition-opacity duration-150 focus-visible:opacity-100 phone-touch:size-11",
                                // With a mouse the mark appears on hover; on touch there is no hover, so it stays
                                hasSelection || isSelected
                                  ? "opacity-100"
                                  : "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-visible:opacity-100 pointer-fine:focus-visible:opacity-100",
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSelect(item.path, idx, e.shiftKey);
                              }}
                            >
                              <SelectMark
                                selected={isSelected}
                                className={isSelected ? "text-foreground" : "text-muted-foreground"}
                              />
                            </button>
                          </div>
                        </TableCell>
                        <TableCell className="overflow-hidden">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <HugeiconsIcon icon={icon} size={18} aria-hidden="true" className={cn("shrink-0", color)} />
                            <span className="truncate text-sm">
                              {folderFilter ? <HighlightedName name={item.name} query={trimmedQuery} /> : item.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden @md:table-cell text-muted-foreground text-xs">
                          {formatDate(item.modified)}
                        </TableCell>
                        <TableCell className="hidden @md:table-cell text-right text-muted-foreground text-xs tabular-nums">
                          {item.isDirectory ? "—" : formatBytes(item.size)}
                        </TableCell>
                        <TableCell className={FILES_LAST_CELL}>
                          <div className="flex justify-end">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  // Tab from the focused row reaches its menu; other rows' menus stay out of the tab order.
                                  tabIndex={item.path === rovingRowPath ? 0 : -1}
                                  // Revealed on hover only where there is hover (a mouse or trackpad): on touch it stays
                                  className="size-6 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-fine:focus-visible:opacity-100 phone-touch:size-11"
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => e.stopPropagation()}
                                  aria-label="File actions"
                                >
                                  <HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40">
                                <FileRowActionItems
                                  menu="dropdown"
                                  item={item}
                                  onOpen={handleRowClick}
                                  onRename={renameItem}
                                  onMove={moveItem}
                                  onDownload={handleDownload}
                                  onDelete={deleteItem}
                                  pinned={favoriteFolders.isFavorite(item.path)}
                                  onTogglePin={embedded ? (folder) => favoriteFolders.toggle(folder.path) : undefined}
                                />
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-44">
                        <FileRowActionItems
                          menu="context"
                          item={item}
                          onOpen={handleRowClick}
                          onRename={renameItem}
                          onMove={moveItem}
                          onDownload={handleDownload}
                          onDelete={deleteItem}
                          pinned={favoriteFolders.isFavorite(item.path)}
                          onTogglePin={embedded ? (folder) => favoriteFolders.toggle(folder.path) : undefined}
                        />
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </TableBody>
            </Table>
            {folderFilter && (
              <button
                type="button"
                onClick={searchSubfolders}
                className="flex min-h-10 w-full items-center gap-2.5 px-[var(--list-gutter,0.75rem)] text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring phone-touch:min-h-11"
              >
                <HugeiconsIcon icon={Search01Icon} size={16} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  Search “{trimmedQuery}” in {folderLabel} and its subfolders
                </span>
              </button>
            )}
          </>
        );
    }
  };

  const quickLookItems = deepSearch ? (search.result?.items ?? NO_ITEMS) : visibleItems;
  const quickLookFiles = useMemo(
    () => quickLookItems.filter((i) => !i.isDirectory && isPreviewable(i.name)).map((i) => i.path),
    [quickLookItems],
  );
  const quickLookSizes = useMemo(() => new Map(quickLookItems.map((i) => [i.path, i.size])), [quickLookItems]);

  return (
    <>
      {/* Hidden file input for upload button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleUpload(filesFromInput(e.target.files));
          e.target.value = "";
        }}
      />
      {/* Hidden folder picker — keeps the folder structure */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          if (e.target.files) handleUpload(filesFromInput(e.target.files));
          e.target.value = "";
        }}
      />
      <UploadPanel
        items={uploads.items}
        onCancel={uploads.cancel}
        onCancelAll={uploads.cancelAll}
        onRetry={uploads.retry}
        onClear={uploads.clearFinished}
      />

      <WindowSidebarLayout
        sidebar={data?.allowedRoots ? (
          <FilesSidebar
            roots={data.allowedRoots}
            currentPath={isAtVirtualRoot ? null : (currentPath ?? data.path ?? null)}
            rootLabel={(root) => rootLabel(root).label}
            favorites={favoriteFolders.favorites}
            onNavigate={navigate}
            onShowAllLocations={hasMultipleRoots ? goToVirtualRoot : undefined}
            onUnpin={favoriteFolders.toggle}
          />
        ) : null}
      >
      {/* Files is a fill route in a window: it owns this column and its one scroller (no shell padding) */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <FilesToolbar
          inputRef={searchInputRef}
          query={query}
          onQueryChange={changeQuery}
          onClear={() => {
            clearSearch();
            searchInputRef.current?.focus();
          }}
          onFieldKeyDown={onFieldKeyDown}
          locationLabel={locationLabel}
          scope={scope}
          onScopeChange={changeScope}
          showScope={trimmedQuery.length > 0 && !isAtVirtualRoot}
          expanded={resultsShown}
          actions={toolbarActions}
        />

        {/* ── Drag overlay ────────────────────────────────────────────── */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/30 bg-primary/5"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <HugeiconsIcon icon={CloudUploadIcon} size={24} className="text-muted-foreground" />
                </div>
                <p className="text-sm text-foreground font-medium">Drop files to upload</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {showListHeader && (
          <FilesListHeader allSelected={allSelected} hasSelection={hasSelection} onToggleSelectAll={toggleSelectAll} />
        )}

        {/* ── List, results or state ──────────────────────────────────── */}
        <div id="files-results" ref={contentRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
          {/* Into a folder the list arrives from the right, back out from the left.
              Keyed on the folder actually shown, so a kept previous listing
              doesn't replay the entrance while the next one loads. */}
          <motion.div
            key={deepSearch ? "search" : isAtVirtualRoot ? "roots" : (data?.path ?? "loading")}
            className="flex min-h-full flex-col"
            initial={reduceMotion ? false : deepSearch
              ? { opacity: 0 }
              : { opacity: 0, x: navDirection * TRAVEL.lift * 2, filter: navDirection ? "blur(3px)" : "blur(0px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            transition={enter()}
          >
            {error && dataIsForThisFolder && (
              <StaleRow loadedAt={listLoadedAt} subject="files" onRetry={() => void mutate()} retrying={isValidating} className="px-[var(--window-pad,0.75rem)] pt-2" />
            )}
            {renderBody()}
          </motion.div>
        </div>

        {/* The status bar and, floating 12px above it, the selection bar. In
            classic mode the status bar is this column's last row, so the
            anchor is as tall as it is (touch targets and the home indicator's
            safe area included); in a window the status bar sits on the
            window's edge and the empty anchor is the column's bottom. */}
        <div data-files-bottom="" className="relative shrink-0">
          <SelectionBar count={selectedVisible.size} className="absolute inset-x-0 bottom-full mb-3">
            <SelectionBarButton icon={FolderExportIcon} label="Move" onClick={() => setMovingPaths(Array.from(selectedVisible))} />
            <SelectionBarButton icon={Download01Icon} label="Download" onClick={handleBulkDownload} />
            <SelectionBarButton icon={Delete01Icon} label="Delete" tone="critical" onClick={() => void confirmBulkDelete()} />
          </SelectionBar>
          <FilesStatusBar
            segments={segments}
            atVirtualRoot={isAtVirtualRoot}
            onNavigate={(path) => navigate(path)}
            countLabel={countLabel}
            searching={deepSearch && search.searching}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
          />
        </div>
      </div>
      </WindowSidebarLayout>

      {/* ── Rename dialog ──────────────────────────────────────────────── */}
      <Dialog open={!!renamingItem} onOpenChange={() => setRenamingItem(null)}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription className="sr-only">
              Enter a new name for the selected file or folder
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleRename(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRenamingItem(null)}>Cancel</Button>
            <Button size="sm" onClick={() => void handleRename()}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Move dialog — folder picker ─────────────────────────────── */}
      <MoveDialog
        open={movingPaths.length > 0}
        itemCount={movingPaths.length}
        onClose={() => setMovingPaths([])}
        onMove={handleMove}
        currentDir={currentPath}
      />

      {/* ── File Quick Look ──────────────────────────────────────────── */}
      <FileQuickLook
        filePath={previewFile}
        onClose={() => setPreviewFile(null)}
        onDownload={handleDownload}
        previewableFiles={quickLookFiles}
        fileSizes={quickLookSizes}
        onNavigate={setPreviewFile}
      />
    </>
  );
}

function FilesPageWithParams() {
  const searchParams = useSearchParams();
  const initialPath = searchParams.get("path");
  return (
    <FilesPageInner
      key={initialPath ?? "__root__"}
      initialPath={initialPath}
      initialReveal={searchParams.get("reveal")}
      initialQuery={searchParams.get("q")}
    />
  );
}

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="min-h-64" aria-busy="true" />}>
      <FilesPageWithParams />
    </Suspense>
  );
}
