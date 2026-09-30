"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";

export type UploadStatus = "queued" | "uploading" | "done" | "skipped" | "failed" | "cancelled";

export interface UploadItem {
  id: string;
  file: File;
  /** Path relative to the target folder — includes subfolders for folder uploads */
  relativePath: string;
  dir: string;
  status: UploadStatus;
  loaded: number;
  error?: string;
  /** Name the server stored it under (may differ when a file already existed) */
  savedAs?: string;
}

/** A file picked from an input or dropped, with its path inside a dropped/selected folder. */
export interface PendingFile {
  file: File;
  relativePath: string;
}

const CONCURRENCY = 3;

/**
 * Uploads go straight to the core server over plain HTTP. Over HTTPS (behind a
 * reverse proxy) the direct http:4000 URL would be blocked as mixed content, so
 * they use the same origin, where app/api/[...path]/route.ts streams the body on
 * to core (the upload path is excluded from proxy.ts, which would buffer it).
 */
function uploadBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.protocol === "https:") return CORE_URL;
  return getDirectCoreUrl();
}

let nextId = 0;

/**
 * Per-file upload queue with progress, cancel and retry. Each file is its own
 * streaming request, so a failure or cancel affects only that file.
 */
export function useUploadQueue(onUploaded: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const requests = useRef(new Map<string, XMLHttpRequest>());
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const start = useCallback((item: UploadItem) => {
    const params = new URLSearchParams({
      dir: item.dir,
      path: item.relativePath,
      size: String(item.file.size),
      conflict: "rename",
    });
    const xhr = new XMLHttpRequest();
    requests.current.set(item.id, xhr);
    xhr.open("PUT", `${uploadBaseUrl()}/api/files/upload-stream?${params}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => update(item.id, { loaded: e.loaded });
    xhr.onload = () => {
      requests.current.delete(item.id);
      let body: { ok?: boolean; error?: string; name?: string; skipped?: boolean } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
        update(item.id, { status: body.skipped ? "skipped" : "done", loaded: item.file.size, savedAs: body.name });
        onUploadedRef.current();
      } else {
        update(item.id, { status: "failed", error: body.error ?? `Upload failed (${xhr.status || "network error"})` });
      }
    };
    xhr.onerror = () => {
      requests.current.delete(item.id);
      update(item.id, { status: "failed", error: "Connection lost" });
    };
    xhr.onabort = () => {
      requests.current.delete(item.id);
      update(item.id, { status: "cancelled" });
    };
    update(item.id, { status: "uploading", loaded: 0, error: undefined });
    xhr.send(item.file);
  }, [update]);

  // Keep up to CONCURRENCY uploads running
  useEffect(() => {
    const running = items.filter((i) => i.status === "uploading").length;
    const queued = items.filter((i) => i.status === "queued");
    for (const item of queued.slice(0, Math.max(0, CONCURRENCY - running))) start(item);
  }, [items, start]);

  const add = useCallback((files: PendingFile[], dir: string) => {
    if (files.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...files.map(({ file, relativePath }) => ({
        id: `upload-${++nextId}`,
        file,
        relativePath: relativePath || file.name,
        dir,
        status: "queued" as const,
        loaded: 0,
      })),
    ]);
  }, []);

  const cancel = useCallback((id: string) => {
    const xhr = requests.current.get(id);
    if (xhr) xhr.abort();
    else setItems((prev) => prev.map((i) => (i.id === id && i.status === "queued" ? { ...i, status: "cancelled" } : i)));
  }, []);

  const cancelAll = useCallback(() => {
    for (const xhr of requests.current.values()) xhr.abort();
    setItems((prev) => prev.map((i) => (i.status === "queued" ? { ...i, status: "cancelled" } : i)));
  }, []);

  const retry = useCallback((id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status: "queued", loaded: 0, error: undefined } : i)));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((i) => i.status === "queued" || i.status === "uploading"));
  }, []);

  const active = items.some((i) => i.status === "queued" || i.status === "uploading");

  // Leaving the page would abort in-flight uploads
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  return { items, active, add, cancel, cancelAll, retry, clearFinished };
}

/** Files from a folder picker (`webkitdirectory`) keep their relative paths. */
export function filesFromInput(list: FileList): PendingFile[] {
  return Array.from(list).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

/** Files and whole folders from a drop, walking directory entries recursively. */
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<PendingFile[]> {
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);

  // Browsers without the entries API: plain files only
  if (entries.length === 0) return Array.from(dataTransfer.files).map((file) => ({ file, relativePath: file.name }));

  const out: PendingFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, relativePath: `${prefix}${file.name}` });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches; keep reading until it returns none
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}
