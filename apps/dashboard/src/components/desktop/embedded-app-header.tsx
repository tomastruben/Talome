"use client";

import { useAtomValue } from "jotai";
import { pageActionAtom } from "@/atoms/page-action";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, ArrowLeft01Icon } from "@/components/icons";

export function EmbeddedAppHeader() {
  const pageAction = useAtomValue(pageActionAtom);
  const pageBack = useAtomValue(pageBackAtom);
  const pageTitle = useAtomValue(pageTitleAtom);
  const desktopActions = useAtomValue(desktopAppActionsAtom);
  const embeddedPageAction = desktopActions.length === 0 ? pageAction : null;

  if (!embeddedPageAction && !pageBack && !pageTitle) return null;

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-3 backdrop-blur-sm">
      {pageBack && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={pageBack}
          aria-label="Go back"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
        </Button>
      )}
      {pageTitle && (
        <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
          {pageTitle}
        </span>
      )}
      {embeddedPageAction}
    </header>
  );
}
