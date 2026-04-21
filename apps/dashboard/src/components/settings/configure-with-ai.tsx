"use client";

import { HugeiconsIcon, AiChat02Icon } from "@/components/icons";
import { useAssistant } from "@/components/assistant/assistant-context";

export function ConfigureWithAI({ prompt, label = "Configure with AI" }: { prompt: string; label?: string }) {
  const { openPaletteInChatMode } = useAssistant();

  return (
    <button
      type="button"
      onClick={() => openPaletteInChatMode(prompt)}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-1 mt-2 cursor-pointer"
    >
      <HugeiconsIcon icon={AiChat02Icon} size={12} />
      {label}
    </button>
  );
}
