"use client";

import { useState } from "react";
import { Streamdown } from "streamdown";
import { CodeBlockContent } from "@/components/ai-elements/code-block";
import { useStreamdownPlugins } from "@/lib/streamdown-plugins";
import { cn } from "@/lib/utils";

const controls = { code: false } as const;

export function MarkdownPreview({ content }: { content: string }) {
  const [view, setView] = useState<"preview" | "source">("preview");
  // Plugins (shiki / KaTeX / mermaid / CJK) load on demand for content that needs them.
  const plugins = useStreamdownPlugins(content);

  return (
    <div className="flex flex-col h-full">
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

      {view === "preview" ? (
        <div className="p-6 pt-3">
          <Streamdown
            className="chat-response size-full"
            plugins={plugins}
            controls={controls}
          >
            {content}
          </Streamdown>
        </div>
      ) : (
        <div className="p-4 text-xs">
          <CodeBlockContent code={content} language="markdown" showLineNumbers />
        </div>
      )}
    </div>
  );
}
