"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import useSWR from "swr";
import dynamic from "next/dynamic";
import { useSetAtom } from "jotai";
import { AnimatePresence, motion } from "framer-motion";
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
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
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
import { pageTitleAtom } from "@/atoms/page-title";
import { pageBackAtom } from "@/atoms/page-back";
import { Progress } from "@/components/ui/progress";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSystemStats } from "@/hooks/use-system-stats";
import { isCodeHighlightable } from "@/lib/file-languages";
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
}

interface ReadResponse {
  path: string;
  name: string;
  size: number;
  modified: string;
  content: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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

function fileIcon(item: FileItem): { icon: IconSvgElement; color: string } {
  if (item.isDirectory) return { icon: Folder01Icon, color: "text-blue-400/80" };
  const e = ext(item.name);
  if (CODE_EXTS.has(e)) return { icon: SourceCodeCircleIcon, color: "text-emerald-400/70" };
  if (CONFIG_EXTS.has(e)) return { icon: Settings01Icon, color: "text-amber-400/70" };
  if (IMAGE_EXTS.has(e)) return { icon: Image01Icon, color: "text-pink-400/70" };
  if (MEDIA_AUDIO.has(e)) return { icon: FileMusicIcon, color: "text-purple-400/70" };
  if (MEDIA_VIDEO.has(e)) return { icon: FileVideoIcon, color: "text-red-400/70" };
  if (DB_EXTS.has(e)) return { icon: Database01Icon, color: "text-cyan-400/70" };
  if (e === PDF_EXT) return { icon: FileAttachmentIcon, color: "text-red-400/70" };
  if (TEXT_EXTS.has(e)) return { icon: FileAttachmentIcon, color: "text-dim-foreground" };
  return { icon: FileAttachmentIcon, color: "text-dim-foreground" };
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
  if (rootPath.includes(".talome")) return { label: "Talome", icon: HardDriveIcon };
  if (rootPath.includes("/tmp")) return { label: "Temp", icon: Folder01Icon };
  return { label: name, icon: Folder01Icon };
}

// ── Skeleton for file table loading state ────────────────────────────────

function FilesTableSkeleton({ rows = 12 }: { rows?: number }) {
  // Varying name widths for visual realism
  const nameWidths = ["w-28", "w-36", "w-24", "w-40", "w-32", "w-20", "w-44", "w-28", "w-36", "w-32", "w-24", "w-40"];
  return (
    <Table className="table-fixed">
      <TableHeader>
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

function RootsList({ roots, onSelect }: { roots: string[]; onSelect: (root: string) => void }) {
  const { stats } = useSystemStats();
  const mounts = stats?.disk.mounts ?? [];

  return (
    <div className="flex flex-col gap-3 max-w-lg mx-auto px-4 pt-2">
      {roots.map((root) => {
        const { label, icon } = rootLabel(root);
        const mount = findMountForRoot(root, mounts);
        const freeBytes = mount ? mount.totalBytes - mount.usedBytes : null;

        return (
          <button
            key={root}
            onClick={() => onSelect(root)}
            className="flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-colors hover:bg-muted/30 text-left group"
          >
            <div className="flex items-center justify-center size-8 rounded-lg bg-muted shrink-0">
              <HugeiconsIcon icon={icon} size={14} className="text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-snug">{label}</p>
              {mount ? (
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
                <p className="text-xs text-muted-foreground mt-0.5">{root}</p>
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
  onNavigate,
}: {
  filePath: string | null;
  onClose: () => void;
  onDownload: (path: string, name: string) => void;
  previewableFiles: string[];
  onNavigate: (path: string) => void;
}) {
  const fileName = filePath?.split("/").pop() || "";

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
      if (e.key === "ArrowLeft") { e.preventDefault(); goToPrev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); goToNext(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filePath, goToPrev, goToNext]);

  // Only fetch text content for text-based files
  const shouldFetch = filePath ? needsTextFetch(fileName) : false;
  const { data: file, isLoading } = useSWR<ReadResponse>(
    shouldFetch ? `${CORE_URL}/api/files/read?path=${encodeURIComponent(filePath!)}` : null,
    fetcher,
  );

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

  const { data } = useSWR<ListResponse>(open ? listUrl : null, fetcher, {
    keepPreviousData: true,
  });

  const folders = data?.items?.filter((i) => i.isDirectory) ?? [];
  const hasMultipleRoots = (data?.allowedRoots?.length ?? 0) > 1;
  const isAtRoot = !browsePath && hasMultipleRoots;

  const handleConfirm = async () => {
    if (!data?.path) return;
    setIsMoving(true);
    onMove(data.path);
  };

  // Current folder name for the header
  const folderName = data?.path?.split("/").filter(Boolean).pop() ?? "Files";

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
        {!isAtRoot && data?.path && (
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
          {isAtRoot && data?.allowedRoots ? (
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
          ) : folders.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-muted-foreground">No subfolders</p>
            </div>
          ) : (
            <div className="py-1">
              {data?.parent && (
                <button
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-muted/30 transition-colors"
                  onClick={() => {
                    if (hasMultipleRoots && data.allowedRoots?.includes(data.path)) {
                      setBrowsePath(null);
                    } else {
                      setBrowsePath(data.parent);
                    }
                  }}
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} size={16} className="text-dim-foreground shrink-0" />
                  <span className="text-sm text-muted-foreground">Back</span>
                </button>
              )}
              {folders.map((folder) => (
                <button
                  key={folder.path}
                  className="flex items-center gap-2.5 w-full px-4 py-2 text-left hover:bg-muted/30 transition-colors group"
                  onClick={() => setBrowsePath(folder.path)}
                >
                  <HugeiconsIcon icon={Folder01Icon} size={16} className="text-blue-400/80 shrink-0" />
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
  const [deletingItem, setDeletingItem] = useState<FileItem | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [movingPaths, setMovingPaths] = useState<string[]>([]);
  const scrollPositions = useRef<Map<string, number>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const lastSelectedIdx = useRef<number | null>(null);
  const setPageAction = useSetAtom(pageActionAtom);
  const setPageTitle = useSetAtom(pageTitleAtom);
  const setPageBack = useSetAtom(pageBackAtom);

  // When currentPath is null, we fetch the default root to get allowedRoots
  const listUrl = currentPath
    ? `${CORE_URL}/api/files/list?path=${encodeURIComponent(currentPath)}&showHidden=${showHidden}`
    : `${CORE_URL}/api/files/list?showHidden=${showHidden}`;

  const { data, error, mutate, isLoading } = useSWR<ListResponse>(listUrl, fetcher, {
    keepPreviousData: true,
  });

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

  const handleDelete = useCallback(async (filePath: string, fileName: string) => {
    const res = await fetch(`${CORE_URL}/api/files`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    const result = await res.json();
    if (result.ok) {
      toast(`Deleted ${fileName}`);
      void mutate();
    } else {
      toast.error(result.error || "Delete failed");
    }
  }, [mutate]);

  const handleRename = useCallback(async () => {
    if (!renamingItem || !renameValue.trim() || renameValue === renamingItem.name) {
      setRenamingItem(null);
      return;
    }
    const res = await fetch(`${CORE_URL}/api/files/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: renamingItem.path, newName: renameValue.trim() }),
    });
    const result = await res.json();
    if (result.ok) {
      toast(`Renamed to ${renameValue.trim()}`);
      void mutate();
    } else {
      toast.error(result.error || "Rename failed");
    }
    setRenamingItem(null);
  }, [renamingItem, renameValue, mutate]);

  const handleNewFolder = useCallback(async () => {
    const name = "New Folder";
    const path = currentPath ? `${currentPath}/${name}` : name;
    const res = await fetch(`${CORE_URL}/api/files/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const result = await res.json();
    if (result.ok) {
      setHighlightedFolder(name);
      void mutate();
      setTimeout(() => setHighlightedFolder(null), 2000);
    } else {
      toast.error(result.error || "Failed to create folder");
    }
  }, [currentPath, mutate]);

  const handleUpload = useCallback(async (files: FileList | File[]) => {
    if (!currentPath || files.length === 0) return;

    const formData = new FormData();
    formData.append("path", currentPath);
    for (const file of Array.from(files)) {
      formData.append("files", file);
    }

    const res = await fetch(`${CORE_URL}/api/files/upload`, {
      method: "POST",
      body: formData,
    });
    const result = await res.json();
    if (result.ok && result.uploaded?.length > 0) {
      toast(`Uploaded ${result.uploaded.length} file${result.uploaded.length > 1 ? "s" : ""}`);
      void mutate();
    }
    if (result.errors?.length > 0) {
      toast.error(result.errors[0]);
    }
  }, [currentPath, mutate]);

  const handleRowClick = useCallback((item: FileItem) => {
    if (item.isDirectory) {
      navigate(item.path);
    } else if (isPreviewable(item.name)) {
      // Text-based previews have a 5MB cap; binary previews (media, PDF, images) stream without limit
      if (needsTextFetch(item.name) && item.size >= 5 * 1024 * 1024) return;
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

  const handleBulkDelete = useCallback(async () => {
    const paths = Array.from(selectedPaths);
    const results = await Promise.all(
      paths.map(path =>
        fetch(`${CORE_URL}/api/files`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        }).then(r => r.json())
      )
    );
    const successCount = results.filter((r: Record<string, unknown>) => r.ok).length;
    if (successCount > 0) {
      toast(`Deleted ${successCount} item${successCount > 1 ? "s" : ""}`);
      setSelectedPaths(new Set());
      lastSelectedIdx.current = null;
      void mutate();
    }
    const failCount = results.filter((r: Record<string, unknown>) => !r.ok).length;
    if (failCount > 0) {
      toast.error(`Failed to delete ${failCount} item${failCount > 1 ? "s" : ""}`);
    }
    setShowBulkDeleteConfirm(false);
  }, [selectedPaths, mutate]);

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

    const res = await fetch(`${CORE_URL}/api/files/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources, destination }),
    });
    const result = await res.json();
    if (result.moved?.length > 0) {
      toast(`Moved ${result.moved.length} item${result.moved.length > 1 ? "s" : ""}`);
      setSelectedPaths(new Set());
      lastSelectedIdx.current = null;
      void mutate();
    }
    if (result.errors?.length > 0) {
      toast.error(result.errors[0].error);
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
    } else {
      setPageAction(
        <FileActions
          onNewFolder={() => void handleNewFolder()}
          onUpload={() => fileInputRef.current?.click()}
        />,
      );
    }
    return () => setPageAction(null);
  }, [setPageAction, handleNewFolder, isAtVirtualRoot]);

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

  const segments: { name: string; path: string }[] = [];
  if (data?.path) {
    const parts = data.path.split("/").filter(Boolean);
    let accumulated = "";
    for (const part of parts) {
      accumulated += "/" + part;
      segments.push({ name: part, path: accumulated });
    }
  }

  if (error && !data) {
    return (
      <EmptyState
        icon={FolderOpenIcon}
        title="Couldn't load files"
        description="The file manager API is unavailable. Is the Talome server running?"
      />
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
              {isLoading && !data ? (
                currentPath ? (
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
                  roots={data.allowedRoots}
                  onSelect={(root) => navigate(root)}
                />
              ) : !data?.items ? (
                <FilesTableSkeleton />
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
                <Table className="table-fixed">
                  <TableHeader>
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
                                    if (item.isDirectory) {
                                      setDeletingItem(item);
                                    } else {
                                      void handleDelete(item.path, item.name);
                                    }
                                  }}
                                >
                                  <HugeiconsIcon icon={Delete01Icon} size={14} />
                                  Delete
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
              transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
              className="absolute bottom-14 inset-x-0 z-20 flex justify-center pointer-events-none"
            >
              <div className="flex items-center gap-1 rounded-full bg-foreground text-background px-4 py-2 shadow-lg pointer-events-auto">
                <span className="text-sm font-medium tabular-nums whitespace-nowrap">{selectedPaths.size} selected</span>
                <div className="w-px h-4 bg-background/15 mx-1" />
                <button
                  type="button"
                  className="inline-flex items-center h-7 gap-1.5 px-2.5 text-xs text-background/70 hover:text-background hover:bg-black/[0.06] rounded-full transition-colors"
                  onClick={() => setMovingPaths(Array.from(selectedPaths))}
                >
                  <HugeiconsIcon icon={FolderExportIcon} size={14} />
                  <span className="hidden sm:inline">Move</span>
                </button>
                <button
                  type="button"
                  className="inline-flex items-center h-7 gap-1.5 px-2.5 text-xs text-background/70 hover:text-background hover:bg-black/[0.06] rounded-full transition-colors"
                  onClick={handleBulkDownload}
                >
                  <HugeiconsIcon icon={Download01Icon} size={14} />
                  <span className="hidden sm:inline">Download</span>
                </button>
                <button
                  type="button"
                  className="inline-flex items-center h-7 gap-1.5 px-2.5 text-xs text-red-700 hover:text-red-800 hover:bg-red-500/[0.08] rounded-full transition-colors"
                  onClick={() => setShowBulkDeleteConfirm(true)}
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
                        if (hasMultipleRoots && data?.allowedRoots?.some((r: string) => r === seg.path || seg.path.length < r.length)) {
                          goToVirtualRoot();
                        } else {
                          navigate(seg.path);
                        }
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

      {/* ── Delete folder confirmation ────────────────────────────────── */}
      <Dialog open={!!deletingItem} onOpenChange={() => setDeletingItem(null)}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete folder</DialogTitle>
            <DialogDescription className="sr-only">
              Confirm permanent deletion of a folder and its contents
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <span className="font-medium text-foreground">{deletingItem?.name}</span> and all its contents? This can&apos;t be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeletingItem(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => {
              if (deletingItem) {
                void handleDelete(deletingItem.path, deletingItem.name);
                setDeletingItem(null);
              }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk delete confirmation ──────────────────────────────────── */}
      <Dialog open={showBulkDeleteConfirm} onOpenChange={() => setShowBulkDeleteConfirm(false)}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {selectedPaths.size} item{selectedPaths.size !== 1 ? "s" : ""}</DialogTitle>
            <DialogDescription className="sr-only">
              Confirm permanent deletion of the selected items
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete {selectedPaths.size} item{selectedPaths.size !== 1 ? "s" : ""}? This can&apos;t be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => void handleBulkDelete()}>Delete</Button>
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
    <Suspense fallback={<FilesTableSkeleton />}>
      <FilesPageWithParams />
    </Suspense>
  );
}
