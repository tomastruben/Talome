import React from "react";

/** Parse **bold** and `code` markers into inline elements. */
export function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        const bold = part.match(/^\*\*(.+)\*\*$/);
        if (bold) return <strong key={i} className="text-foreground font-medium">{bold[1]}</strong>;
        const code = part.match(/^`(.+)`$/);
        if (code) return <code key={i} className="text-foreground/80 font-mono text-[0.85em] bg-muted/30 px-1 rounded">{code[1]}</code>;
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}
