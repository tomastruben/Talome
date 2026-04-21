"use client";

import { useState } from "react";
import { HugeiconsIcon, Copy01Icon, Tick01Icon } from "@/components/icons";

export const InstallCommand = () => {
  const [copied, setCopied] = useState(false);
  const command = "curl -fsSL https://get.talome.dev | bash";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative mx-auto w-fit">
      <div className="flex items-center gap-3 rounded-2xl border border-border/20 bg-card/15 px-6 py-3.5 font-mono text-sm backdrop-blur-sm">
        <span className="text-muted-foreground/30 select-none">$</span>
        <code className="text-foreground/80">{command}</code>
        <button
          onClick={handleCopy}
          className="ml-1 cursor-pointer text-muted-foreground/40 transition-colors hover:text-foreground"
          aria-label="Copy install command"
        >
          <HugeiconsIcon
            icon={copied ? Tick01Icon : Copy01Icon}
            size={14}
            className={copied ? "text-status-healthy" : ""}
          />
        </button>
      </div>
    </div>
  );
};
