"use client";
import { Suspense, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { FileQuickLook } from "@/components/file-preview/file-quick-look";
import { isPreviewable, parentPath, type FileItem } from "@/components/files/file-helpers";
import { CORE_URL } from "@/lib/constants";
import { fetchJson } from "@/lib/fetch-json";
import { EmptyState } from "@/components/ui/empty-state";
function FilePreviewPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const path = params.get("path");
  const folder = path ? parentPath(path) : null;
  const { data } = useSWR<{ items: FileItem[] }>(folder ? `${CORE_URL}/api/files/list?path=${encodeURIComponent(folder)}` : null, fetchJson, { shouldRetryOnError: false });
  const files = useMemo(() => data?.items.filter(item => !item.isDirectory && isPreviewable(item.name)).map(item => item.path) ?? (path ? [path] : []), [data, path]);
  const sizes = useMemo(() => new Map(data?.items.map(item => [item.path, item.size])), [data]);
  const navigate = useCallback((next: string) => router.replace(`/dashboard/files/preview?path=${encodeURIComponent(next)}`, { scroll: false }), [router]);
  const download = useCallback((filePath: string, name: string) => {
    const link = document.createElement("a");
    link.href = `${CORE_URL}/api/files/download?path=${encodeURIComponent(filePath)}`;
    link.download = name;
    link.click();
  }, []);
  if (!path) return <EmptyState title="Choose a file to preview" />;
  return <FileQuickLook standalone filePath={path} previewableFiles={files} fileSizes={sizes} onNavigate={navigate} onDownload={download} onClose={() => router.back()} />;
}
export default function FilePreviewPage() {
  return <Suspense fallback={<div aria-busy="true" />}><FilePreviewPageInner /></Suspense>;
}
