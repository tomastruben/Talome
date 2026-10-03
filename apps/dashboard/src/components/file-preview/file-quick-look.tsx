"use client";
import { useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import { HugeiconsIcon, FileAttachmentIcon, Download01Icon, ArrowLeft02Icon, ArrowRight02Icon, Cancel01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { ext, fileIcon, isAudioPreviewable, isImagePreviewable, isMarkdownFile, isOverTextPreviewLimit, isPDF, isSvgFile, isVideoPreviewable, needsTextFetch, shouldHandleQuickLookKey } from "@/components/files/file-helpers";
import { fetchJson, fetchErrorStatus } from "@/lib/fetch-json";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isCodeHighlightable } from "@/lib/file-languages";
const fetcher = <T,>(url: string) => fetchJson<T>(url);
const VideoPlayer = dynamic(() => import("@/components/files/media-player").then(m => ({ default: m.VideoPlayer })), { ssr: false });
const AudioPlayer = dynamic(() => import("@/components/files/media-player").then(m => ({ default: m.AudioPlayer })), { ssr: false });
const CodePreview = dynamic(() => import("@/components/file-preview/code-preview").then(m => ({ default: m.CodePreview })), { ssr: false });
const MarkdownPreview = dynamic(() => import("@/components/file-preview/markdown-preview").then(m => ({ default: m.MarkdownPreview })), { ssr: false });
const ImagePreview = dynamic(() => import("@/components/file-preview/image-preview").then(m => ({ default: m.ImagePreview })), { ssr: false });
const PDFPreview = dynamic(() => import("@/components/file-preview/pdf-preview").then(m => ({ default: m.PDFPreview })), { ssr: false });
interface ReadResponse { path: string; name: string; size: number; modified: string; content: string; }
export function FileQuickLook({
  standalone = false,
  filePath,
  onClose,
  onDownload,
  previewableFiles,
  fileSizes,
  onNavigate,
}: {
  standalone?: boolean;
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

  const embedded = useIsEmbeddedFrame();
  const content = <>
        {/* ── Header bar ──────────────────────────────────────────────── */}
        <DesktopAppToolbar windowTitle={standalone ? fileName : undefined} detached={!standalone} className="flex h-12 min-w-0 items-center gap-2 px-4 border-b border-border shrink-0">
          {!(standalone && embedded) && <div className={cn("flex items-center justify-center size-7 rounded-md bg-muted/50 shrink-0", color)}>
            <HugeiconsIcon icon={icon} size={14} />
          </div>}
          {!(standalone && embedded) && <span className="font-medium text-sm text-muted-foreground truncate">
            {file?.name || fileName}
          </span>}
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
            {!standalone && <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground phone-touch:size-11"
              onClick={onClose}
              aria-label="Close preview"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
            </Button>}
          </div>
        </DesktopAppToolbar>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">{renderContent()}</div>
      </>;
  if (standalone) return <div className="flex h-full min-h-0 flex-col">{content}</div>;
  return (
    <Dialog open={!!filePath} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 overflow-hidden w-[calc(100vw-1.5rem)] h-[calc(100svh-1.5rem)] max-w-none! sm:max-w-none! flex flex-col rounded-3xl sm:w-[calc(100vw-2.5rem)] sm:h-[calc(100svh-2.5rem)]">
        <DialogTitle className="sr-only">{fileName || "File Preview"}</DialogTitle>
        <DialogDescription className="sr-only">Preview and download the selected file</DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  );
}
