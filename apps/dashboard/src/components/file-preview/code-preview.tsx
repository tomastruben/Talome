"use client";

import { CodeBlockContent } from "@/components/ai-elements/code-block";
import { getLanguageFromExtension } from "@/lib/file-languages";

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function CodePreview({ code, filePath }: { code: string; filePath: string }) {
  const fileName = filePath.split("/").pop() || "";
  const language = getLanguageFromExtension(ext(fileName));

  if (!language) {
    return (
      <pre className="text-xs leading-relaxed font-mono whitespace-pre-wrap break-words p-6 text-muted-foreground selection:bg-primary/20">
        {code}
      </pre>
    );
  }

  return (
    <div className="p-4 text-xs">
      <CodeBlockContent code={code} language={language} showLineNumbers />
    </div>
  );
}
