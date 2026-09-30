"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import dynamic from "next/dynamic";
import { useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { enter } from "@/lib/motion";
import {
  HugeiconsIcon,
  Folder01Icon,
  FolderOpenIcon,
  FileAttachmentIcon,
  FileMusicIcon,
  FileVideoIcon,
  Image01Icon,
  SourceCodeCircleIcon,
  Settings01Icon,
  Database01Icon,
  Download01Icon,
  Delete01Icon,
  Edit02Icon,
  MoreHorizontalIcon,
  Add01Icon,
  CloudUploadIcon,
  FolderAddIcon,
  ExternalDriveIcon,
  HardDriveIcon,
  Cancel01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  FolderExportIcon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { promiseToast } from "@/components/ui/sonner";
import { toastWarning } from "@/lib/toast";
import { StaleRow, useLoadedAt, useLoadingPhase } from "@/components/data-state/data-state";
import {
  folderErrorCopy,
  listDataIsFor,
  isOverTextPreviewLimit,
  shouldHandleQuickLookKey,
  uniqueName,
} from "@/components/files/file-helpers";
import { fetchJson, fetchErrorStatus } from "@/lib/fetch-json";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
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
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";
import { pageTitleAtom } from "@/atoms/page-title";
import { pageBackAtom } from "@/atoms/page-back";
import { Progress } from "@/components/ui/progress";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSystemStats } from "@/hooks/use-system-stats";
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

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string | null;
}

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

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const CODE_EXTS = new Set(["js", "ts", "tsx", "jsx", "py", "go", "rs", "sh", "bash", "zsh", "sql", "dockerfile"]);
const CONFIG_EXTS = new Set(["json", "yml", "yaml", "toml", "ini", "conf", "cfg", "env", "xml", "csv"]);
const TEXT_EXTS = new Set(["txt", "md", "log", "html", "css"]);
const MEDIA_AUDIO = new Set(["mp3", "flac", "ogg", "wav", "aac", "m4a", "m4b"]);
const MEDIA_VIDEO = new Set(["mp4", "mkv", "avi", "mov", "webm"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
const DB_EXTS = new Set(["db", "sqlite", "sqlite3"]);
const PDF_EXT = "pdf";

function isTextPreviewable(name: string): boolean {
  const e = ext(name);
  return CODE_EXTS.has(e) || CONFIG_EXTS.has(e) || TEXT_EXTS.has(e) || name.startsWith(".");
}

function isImagePreviewable(name: string): boolean {
  return IMAGE_EXTS.has(ext(name));
}

function isPDF(name: string): boolean {
  return ext(name) === PDF_EXT;
}

function isMarkdownFile(name: string): boolean {
  const e = ext(name);
  return e === "md" || e === "mdx";
}

function isSvgFile(name: string): boolean {
  return ext(name) === "svg";
}

/** True if the file needs the /api/files/read text fetch. */
function needsTextFetch(name: string): boolean {
  return isTextPreviewable(name) || isMarkdownFile(name) || isSvgFile(name);
}

/** True if this file type can be previewed (for click handling). */
function isPreviewable(name: string): boolean {
  return isTextPreviewable(name) || isImagePreviewable(name) || isMediaPreviewable(name) || isPDF(name);
}

function isAudioPreviewable(name: string): boolean {
  return MEDIA_AUDIO.has(ext(name));
}

function isVideoPreviewable(name: string): boolean {
  return MEDIA_VIDEO.has(ext(name));
}

function isMediaPreviewable(name: string): boolean {
  return isAudioPreviewable(name) || isVideoPreviewable(name);
}

/** Type icons are muted: the glyph says the type, colour is not a signal here. */
function fileIcon(item: FileItem): { icon: IconSvgElement; color: string } {
  if (item.isDirectory) return { icon: Folder01Icon, color: "text-muted-foreground" };
  const e = ext(item.name);
  const color = "text-dim-foreground";
  if (CODE_EXTS.has(e)) return { icon: SourceCodeCircleIcon, color };
  if (CONFIG_EXTS.has(e)) return { icon: Settings01Icon, color };
  if (IMAGE_EXTS.has(e)) return { icon: Image01Icon, color };
  if (MEDIA_AUDIO.has(e)) return { icon: FileMusicIcon, color };
  if (MEDIA_VIDEO.has(e)) return { icon: FileVideoIcon, color };
  if (DB_EXTS.has(e)) return { icon: Database01Icon, color };
  return { icon: FileAttachmentIcon, color };
}

function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function formatFullDate(iso: string | null): string {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

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
    <Table className="table-fixed" containerClassName="overflow-visible">
      <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85">
        <TableRow className="hover:bg-transparent border-border/50">
          <TableHead className="w-9 pl-3 pr-0">
            <div className="flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-dim-foreground">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </div>
          </TableHead>
          <TableHead className="overflow-hidden">Name</TableHead>
          <TableHead className="hidden sm:table-cell w-[25%]">Modified</TableHead>
          <TableHead className="hidden sm:table-cell text-right w-[15%]">Size</TableHead>
          <TableHead className="w-9" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, i) => (
          <TableRow key={i} className="border-transparent">
            <TableCell className="py-1.5 w-9 pl-3 pr-0">
              <div className="flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-dim-foreground">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
            </TableCell>
            <TableCell className="py-1.5 overflow-hidden">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-5 rounded shrink-0" />
                <Skeleton className={cn("h-3.5 rounded", nameWidths[i % nameWidths.length])} />
              </div>
            </TableCell>
            <TableCell className="hidden sm:table-cell py-1.5">
              <Skeleton className="h-3 w-16 rounded" />
            </TableCell>
            <TableCell className="hidden sm:table-cell py-1.5 text-right">
              {i % 3 !== 0 && <Skeleton className="h-3 w-10 rounded ml-auto" />}
            </TableCell>
            <TableCell className="py-1.5 w-9" />
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
    <div className="flex min-h-full flex-col justify-center px-4 py-6">
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

// ── Header actions (rendered via pageActionAtom) ────────────────────────

function FileActions({ onNewFolder, onUpload }: { onNewFolder: () => void; onUpload: () => void }) {
  return (
    <div className="ml-auto flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={onUpload}
      >
        <HugeiconsIcon icon={CloudUploadIcon} size={14} />
        Upload
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={onNewFolder}
      >
        <HugeiconsIcon icon={FolderAddIcon} size={14} />
        New
      </Button>
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
    ? fileIcon({ name: fileName, isDirectory: false, path: "", size: 0, modified: null })
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
                  className="size-7 text-muted-foreground hover:text-foreground disabled:text-dim-foreground disabled:pointer-events-none"
                  onClick={goToPrev}
                  disabled={!hasPrev}
                  aria-label="Previous file"
                >
                  <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
                </Button>
                <span className="text-[10px] tabular-nums text-muted-foreground min-w-[2.5rem] text-center">
                  {currentIndex + 1} / {previewableFiles.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground disabled:text-dim-foreground disabled:pointer-events-none"
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
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => filePath && onDownload(filePath, fileName)}
            >
              <HugeiconsIcon icon={Download01Icon} size={12} />
              <span className="hidden sm:inline">Download</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
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
                className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5 rounded"
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
                    className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-muted/30 transition-colors"
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
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-muted/30 transition-colors"
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
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-muted/30 transition-colors group"
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
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
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

// ── Page component ──────────────────────────────────────────────────────

function FilesPageInner({ initialPath }: { initialPath: string | null }) {
  const router = useRouter();
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [renamingItem, setRenamingItem] = useState<FileItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [highlightedFolder, setHighlightedFolder] = useState<string | null>(null);
  const [movingPaths, setMovingPaths] = useState<string[]>([]);
  const confirm = useConfirm();
  const scrollPositions = useRef<Map<string, number>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const lastSelectedIdx = useRef<number | null>(null);
  const setPageAction = useSetAtom(pageActionAtom);
  const setDesktopAppActions = useSetAtom(desktopAppActionsAtom);
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

  const hasSelection = selectedPaths.size > 0;

  const navigate = useCallback((path: string) => {
    // Save scroll position of current view
    const scrollParent = contentRef.current;
    if (scrollParent) {
      const key = currentPath ?? "root-view";
      scrollPositions.current.set(key, scrollParent.scrollTop);
    }
    setCurrentPath(path);
    setSelectedPaths(new Set());
    lastSelectedIdx.current = null;
    // Update title atomically to prevent blink
    const isRoot = hasMultipleRoots && data?.allowedRoots?.includes(path);
    const folderName = isRoot
      ? rootLabel(path).label
      : path.split("/").filter(Boolean).pop() || "Files";
    setPageTitle(folderName);
    router.replace(`/dashboard/files?path=${encodeURIComponent(path)}`, { scroll: false });
  }, [currentPath, router, hasMultipleRoots, data?.allowedRoots, setPageTitle]);

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
        setHighlightedFolder(name);
        await mutate();
        setTimeout(() => setHighlightedFolder(null), 2000);
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
  }, [currentPath, data?.items, mutate]);

  const handleUpload = useCallback((files: FileList | File[]) => {
    if (!currentPath) return;
    const folder = currentPath;
    const destination = folder.split("/").filter(Boolean).pop() ?? "this folder";

    const start = (list: File[]) => {
      if (list.length === 0) return;
      const label = list.length === 1 ? list[0].name : `${list.length} files`;
      const run = async (): Promise<{ uploaded: string[]; errors: string[] }> => {
        const formData = new FormData();
        formData.append("path", folder);
        for (const file of list) formData.append("files", file);
        let res: Response;
        try {
          res = await fetch(`${CORE_URL}/api/files/upload`, { method: "POST", credentials: "include", body: formData });
        } catch {
          throw new Error("the Talome server didn't answer");
        }
        const result = (await res.json().catch(() => null)) as { ok?: boolean; uploaded?: string[]; errors?: string[]; error?: string } | null;
        if (!res.ok || !result) throw new Error(result?.error ?? `the server answered ${res.status}`);
        const uploaded = result.uploaded ?? [];
        const errors = result.errors ?? [];
        void mutate();
        if (uploaded.length === 0) throw new Error(errors[0] ?? "nothing was uploaded");
        if (errors.length > 0) {
          toastWarning(`Skipped ${errors.length === 1 ? "1 file" : `${errors.length} files`}`, { description: errors[0] });
        }
        return { uploaded, errors };
      };

      void promiseToast(run, {
        loading: `Uploading ${label}…`,
        success: ({ uploaded }) => `Uploaded ${uploaded.length === 1 ? uploaded[0] : `${uploaded.length} files`} to ${destination}`,
        error: (err) => `Couldn't upload ${label}: ${err instanceof Error ? err.message : "unknown error"}.`,
        onRetry: () => start(list),
      }).catch(() => {
        // Reported in the toast, with Retry.
      });
    };

    start(Array.from(files));
  }, [currentPath, mutate]);

  const handleRowClick = useCallback((item: FileItem) => {
    if (item.isDirectory) {
      navigate(item.path);
    } else if (isPreviewable(item.name)) {
      // Every previewable file opens Quick Look; text over the 5MB limit
      // opens a "Too large" preview with Download (it used to do nothing).
      setPreviewFile(item.path);
    }
  }, [navigate]);

  // ── Multi-select ──────────────────────────────────────────────────────

  const toggleSelect = useCallback((path: string, idx: number, shiftKey: boolean) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedIdx.current !== null && data?.items) {
        const start = Math.min(lastSelectedIdx.current, idx);
        const end = Math.max(lastSelectedIdx.current, idx);
        for (let i = start; i <= end; i++) {
          next.add(data.items[i].path);
        }
      } else {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      }
      return next;
    });
    lastSelectedIdx.current = idx;
  }, [data?.items]);

  const allSelected = !!(data?.items && data.items.length > 0 && data.items.every(item => selectedPaths.has(item.path)));

  const toggleSelectAll = useCallback(() => {
    if (!data?.items) return;
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(data.items.map(i => i.path)));
    }
  }, [data?.items, allSelected]);

  const confirmBulkDelete = useCallback(async () => {
    const paths = Array.from(selectedPaths);
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
  }, [confirm, currentPath, data?.items, deletePath, mutate, selectedPaths]);

  const handleBulkDownload = useCallback(() => {
    for (const path of selectedPaths) {
      const item = data?.items?.find(i => i.path === path);
      if (item && !item.isDirectory) {
        handleDownload(item.path, item.name);
      }
    }
  }, [selectedPaths, data?.items, handleDownload]);

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
    if (e.dataTransfer.files.length > 0) {
      void handleUpload(e.dataTransfer.files);
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

  // Escape to clear selection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedPaths.size > 0) {
        setSelectedPaths(new Set());
        lastSelectedIdx.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPaths.size]);

  useEffect(() => {
    if (isAtVirtualRoot) {
      setPageAction(null);
      setDesktopAppActions([]);
    } else {
      setPageAction(
        <FileActions
          onNewFolder={() => void handleNewFolder()}
          onUpload={() => fileInputRef.current?.click()}
        />,
      );
      setDesktopAppActions([
        {
          id: "upload",
          label: "Upload",
          icon: "upload",
          onSelect: () => fileInputRef.current?.click(),
        },
        {
          id: "new-folder",
          label: "New",
          icon: "new-folder",
          onSelect: () => void handleNewFolder(),
        },
      ]);
    }
    return () => {
      setPageAction(null);
      setDesktopAppActions([]);
    };
  }, [setPageAction, setDesktopAppActions, handleNewFolder, isAtVirtualRoot]);

  // Wire atom-based drilldown: show folder name + back button in header.
  // Uses useLayoutEffect + currentPath (not data?.path) so the title is set
  // before paint — prevents the "Files" default label from flashing.
  useLayoutEffect(() => {
    if (currentPath) {
      const isRoot = hasMultipleRoots && data?.allowedRoots?.includes(currentPath);
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

  // ── Path segments ───────────────────────────────────────────────────

  // Build breadcrumbs from the user-visible root instead of exposing the
  // server's host path (for example /Users/<name>/.talome/files). This also
  // keeps external-drive breadcrumbs stable when their mount path changes.
  const segments: { name: string; path: string }[] = [];
  if (data?.path) {
    const matchingRoot = (data.roots ?? [])
      .filter((root) => data.path === root.path || data.path.startsWith(`${root.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];

    if (matchingRoot) {
      segments.push({ name: matchingRoot.label, path: matchingRoot.path });
      const parts = data.path.slice(matchingRoot.path.length).split("/").filter(Boolean);
      let accumulated = matchingRoot.path;
      for (const part of parts) {
        accumulated += `/${part}`;
        segments.push({ name: part, path: accumulated });
      }
    } else {
      segments.push({
        name: data.path.split("/").filter(Boolean).pop() || "Files",
        path: data.path,
      });
    }
  }

  if (error && !dataIsForThisFolder) {
    const copy = folderErrorCopy(fetchErrorStatus(error), currentPath);
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <ErrorState title={copy.title} description={copy.description} onRetry={() => void mutate()} className="w-full max-w-lg" />
        {currentPath && (
          <Button variant="ghost" size="sm" onClick={goToVirtualRoot}>
            Back to Files
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Hidden file input for upload button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleUpload(e.target.files);
          e.target.value = "";
        }}
      />

      <div
        className="flex flex-col flex-1 min-h-0 relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* ── Drag overlay ────────────────────────────────────────────── */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 backdrop-blur-sm"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <HugeiconsIcon icon={CloudUploadIcon} size={24} className="text-primary/60" />
                </div>
                <p className="text-sm text-primary/60 font-medium">Drop files to upload</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── File table ──────────────────────────────────────────────── */}
        <div ref={contentRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-none">
              {error && dataIsForThisFolder && (
                <StaleRow loadedAt={listLoadedAt} subject="files" onRetry={() => void mutate()} retrying={isValidating} className="px-3 pt-2" />
              )}
              {loadingPhase === "skeleton" || !data ? (
                // Branch on the phase itself: once shown, the skeleton stays its
                // minimum time even if the data arrived (no flash).
                loadingPhase !== "skeleton" ? (
                  <div className="min-h-64" aria-busy="true" />
                ) : currentPath ? (
                  <FilesTableSkeleton />
                ) : (
                  <div className="flex flex-col gap-3 max-w-lg mx-auto px-4 pt-2">
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
                )
              ) : isAtVirtualRoot && data?.allowedRoots ? (
                <RootsList
                  roots={getVisibleFileRoots(
                    data.roots ?? data.allowedRoots.map((root) => ({
                      id: root,
                      path: root,
                      label: rootLabel(root).label,
                      kind: root.includes(".talome/files") ? "talome-files" : "external",
                    })),
                    { keepTalomeFallback: true },
                  )}
                  onSelect={(root) => navigate(root)}
                />
              ) : !data?.items ? (
                <div className="min-h-64" aria-busy="true" />
              ) : data.items.length === 0 ? (
                <EmptyState
                  icon={FolderOpenIcon}
                  title="Empty folder"
                  description="Drop files here or use the upload button."
                  action={
                    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                      <HugeiconsIcon icon={CloudUploadIcon} size={14} />
                      Upload files
                    </Button>
                  }
                />
              ) : (
                <Table className="table-fixed" containerClassName="overflow-visible">
                  <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85">
                    <TableRow className="hover:bg-transparent border-border/50">
                      <TableHead className="w-9 pl-3 pr-0">
                        <div className="flex items-center justify-center">
                          <button
                            className="flex items-center justify-center transition-all duration-150"
                            onClick={toggleSelectAll}
                          >
                            {allSelected ? (
                              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} className="text-foreground" />
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={cn(
                                "transition-colors duration-150",
                                hasSelection ? "text-dim-foreground" : "text-dim-foreground"
                              )}>
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </TableHead>
                      <TableHead className="overflow-hidden">Name</TableHead>
                      <TableHead className="hidden sm:table-cell w-[25%]">Modified</TableHead>
                      <TableHead className="hidden sm:table-cell text-right w-[15%]">Size</TableHead>
                      <TableHead className="w-9" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.items?.map((item, idx) => {
                      const { icon, color } = fileIcon(item);
                      const clickable = item.isDirectory || isPreviewable(item.name);
                      const isSelected = selectedPaths.has(item.path);
                      const isHighlighted = item.name === highlightedFolder;

                      return (
                        <TableRow
                          key={item.path}
                          className={cn(
                            "group border-transparent transition-colors",
                            clickable && "cursor-pointer",
                            isSelected && "bg-muted/40",
                          )}
                          style={isHighlighted ? { animation: "folder-highlight 2s ease-out" } : undefined}
                          onClick={() => handleRowClick(item)}
                        >
                          <TableCell className="py-1.5 w-9 pl-3 pr-0">
                            <div className="flex items-center justify-center">
                              <button
                                className="flex items-center justify-center transition-all duration-150"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleSelect(item.path, idx, e.shiftKey);
                                }}
                              >
                                {isSelected ? (
                                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} className="text-foreground" />
                                ) : (
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={cn(
                                    "transition-colors duration-150",
                                    hasSelection ? "text-dim-foreground" : "text-dim-foreground group-hover:text-muted-foreground"
                                  )}>
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </TableCell>
                          <TableCell className="py-1.5 overflow-hidden">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <HugeiconsIcon icon={icon} size={18} className={cn("shrink-0", color)} />
                              <span className="truncate text-sm">{item.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell py-1.5 text-muted-foreground text-xs">
                            {formatDate(item.modified)}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell py-1.5 text-right text-muted-foreground text-xs tabular-nums">
                            {item.isDirectory ? "\u2014" : formatBytes(item.size)}
                          </TableCell>
                          <TableCell className="py-1.5 w-9 pr-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label="File actions"
                                >
                                  <HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40">
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingItem(item);
                                    setRenameValue(item.name);
                                  }}
                                >
                                  <HugeiconsIcon icon={Edit02Icon} size={14} />
                                  Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMovingPaths([item.path]);
                                  }}
                                >
                                  <HugeiconsIcon icon={FolderExportIcon} size={14} />
                                  Move to…
                                </DropdownMenuItem>
                                {!item.isDirectory && (
                                  <DropdownMenuItem
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDownload(item.path, item.name);
                                    }}
                                  >
                                    <HugeiconsIcon icon={Download01Icon} size={14} />
                                    Download
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void confirmDelete(item);
                                  }}
                                >
                                  <HugeiconsIcon icon={Delete01Icon} size={14} />
                                  Delete permanently…
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
        </div>

        {/* ── Floating selection bar ──────────────────────────────────── */}
        <AnimatePresence>
          {hasSelection && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={enter()}
              className="absolute bottom-14 inset-x-0 z-20 flex justify-center pointer-events-none"
            >
              {/* Inverted surface: status text uses the -inverse token (both themes checked in design-contrast.test). */}
              <div className="flex items-center gap-1 rounded-full bg-foreground text-background px-4 py-2 shadow-lg pointer-events-auto">
                <span className="text-sm font-medium tabular-nums whitespace-nowrap">{selectedPaths.size} selected</span>
                <div className="w-px h-4 bg-background/15 mx-1" />
                <button
                  type="button"
                  className="inline-flex items-center h-7 gap-1.5 px-2.5 text-xs text-background/70 hover:text-background hover:bg-background/10 rounded-full transition-colors"
                  onClick={() => setMovingPaths(Array.from(selectedPaths))}
                >
                  <HugeiconsIcon icon={FolderExportIcon} size={14} />
                  <span className="hidden sm:inline">Move</span>
                </button>
                <button
                  type="button"
                  className="inline-flex items-center h-7 gap-1.5 px-2.5 text-xs text-background/70 hover:text-background hover:bg-background/10 rounded-full transition-colors"
                  onClick={handleBulkDownload}
                >
                  <HugeiconsIcon icon={Download01Icon} size={14} />
                  <span className="hidden sm:inline">Download</span>
                </button>
                <button
                  type="button"
                  className="inline-flex items-center h-7 gap-1.5 px-2.5 text-xs text-status-critical-inverse hover:bg-background/10 rounded-full transition-colors"
                  onClick={() => void confirmBulkDelete()}
                >
                  <HugeiconsIcon icon={Delete01Icon} size={14} />
                  <span className="hidden sm:inline">Delete</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Finder-style path bar — frosted glass, fixed bottom ────── */}
        {!isAtVirtualRoot && segments.length > 0 && (
        <div className="shrink-0 z-10 pb-[env(safe-area-inset-bottom)] relative">
          <div className="absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-background/80 to-transparent pointer-events-none" />
          <div className="absolute inset-0 bg-background/80 backdrop-blur-xl border-t border-border/40" />
          <div className="relative flex items-center h-9 px-3">
            <div className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
              {segments.map((seg, i) => {
                const isLast = i === segments.length - 1;
                return (
                  <span key={seg.path} className="flex items-center shrink-0">
                    {i > 0 && (
                      <span className="text-dim-foreground text-xs mx-0.5 select-none">/</span>
                    )}
                    <button
                      className={cn(
                        "text-xs tracking-wide px-1.5 py-1 rounded-md transition-colors truncate max-w-36",
                        isLast
                          ? "text-muted-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.06]",
                      )}
                      onClick={() => {
                        if (isLast) return;
                        navigate(seg.path);
                      }}
                      disabled={isLast}
                    >
                      {seg.name}
                    </button>
                  </span>
                );
              })}
            </div>
            <button
              className="text-xs tracking-wide text-dim-foreground hover:text-muted-foreground transition-colors shrink-0 px-1.5 py-1 rounded-md hover:bg-white/[0.06]"
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? "Hide dotfiles" : "Dotfiles"}
            </button>
          </div>
        </div>
        )}
      </div>

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
        previewableFiles={(data?.items ?? [])
          .filter((i) => !i.isDirectory && isPreviewable(i.name))
          .map((i) => i.path)}
        fileSizes={new Map((data?.items ?? []).map((i) => [i.path, i.size]))}
        onNavigate={setPreviewFile}
      />
    </>
  );
}

function FilesPageWithParams() {
  const searchParams = useSearchParams();
  const initialPath = searchParams.get("path");
  return <FilesPageInner key={initialPath ?? "__root__"} initialPath={initialPath} />;
}

export default function FilesPage() {
  return (
    <Suspense fallback={<div className="min-h-64" aria-busy="true" />}>
      <FilesPageWithParams />
    </Suspense>
  );
}
