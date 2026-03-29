"use client";

import { useEffect } from "react";
import { HugeiconsIcon, Bug01Icon } from "@/components/icons";
import { useBugHunt } from "@/components/bug-hunt/bug-hunt-context";

export default function BugHuntPage() {
  const { open, isOpen } = useBugHunt();

  // Auto-open overlay when this page is visited directly
  useEffect(() => {
    if (!isOpen) open();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
      <HugeiconsIcon icon={Bug01Icon} size={24} className="text-dim-foreground" />
      <p className="text-sm text-muted-foreground">
        Bug Hunt opens as an overlay from any page.
      </p>
      <p className="text-xs text-muted-foreground">
        Press {"\u21E7\u2318"}X or open via {"\u2318"}K.
      </p>
    </div>
  );
}
