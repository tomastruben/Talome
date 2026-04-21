"use client";

import { useState, useEffect } from "react";
import { CodeBlockContent } from "@/components/ai-elements/code-block";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function ImagePreview({
  downloadUrl,
  fileName,
  svgSource,
  thumbnailUrl,
}: {
  downloadUrl: string;
  fileName: string;
  svgSource?: string;
  thumbnailUrl?: string;
}) {
  const isSvg = fileName.toLowerCase().endsWith(".svg");
  const [view, setView] = useState<"preview" | "source">("preview");
  const [loaded, setLoaded] = useState(false);

  // Reset loading state when the image URL changes
  useEffect(() => {
    setLoaded(false);
  }, [downloadUrl]);

  return (
    <div className="flex flex-col h-full">
      {isSvg && svgSource && (
        <div className="flex items-center gap-1 px-4 pt-3 pb-1">
          <button
            type="button"
            onClick={() => setView("preview")}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md transition-colors",
              view === "preview"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => setView("source")}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md transition-colors",
              view === "source"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Source
          </button>
        </div>
      )}

      {view === "preview" ? (
        <div className="flex-1 min-h-0 flex items-center justify-center relative">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-5 text-dim-foreground" />
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl || downloadUrl}
            alt={fileName}
            onLoad={() => setLoaded(true)}
            className={cn(
              "max-w-full max-h-full object-contain transition-opacity duration-150",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      ) : svgSource ? (
        <div className="p-4 text-xs">
          <CodeBlockContent code={svgSource} language="xml" showLineNumbers />
        </div>
      ) : null}
    </div>
  );
}
