"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { VideoPlayer } from "@/components/files/media-player";
import { getDirectCoreUrl } from "@/lib/constants";

function PlayerContent() {
  const searchParams = useSearchParams();
  const filePath = searchParams.get("path") ?? "";
  const fileName = searchParams.get("name") ?? "";
  const preferOriginal = searchParams.get("original") === "true";
  const preferDirect = searchParams.get("direct") === "true";
  const mediaApiBase = `${getDirectCoreUrl()}/api/media`;

  if (!filePath || !fileName) {
    return (
      <div className="flex size-full items-center justify-center bg-black text-sm text-white/60">
        This movie is unavailable.
      </div>
    );
  }

  return (
    <div className="size-full min-h-0 bg-black">
      <VideoPlayer
        src={`${mediaApiBase}/stream?path=${encodeURIComponent(filePath)}`}
        fileName={fileName}
        filePath={filePath}
        apiBase={mediaApiBase}
        preferOriginal={preferOriginal}
        preferDirect={preferDirect}
      />
    </div>
  );
}

export default function PlayerPage() {
  return (
    <Suspense fallback={<div className="size-full bg-black" />}>
      <PlayerContent />
    </Suspense>
  );
}
