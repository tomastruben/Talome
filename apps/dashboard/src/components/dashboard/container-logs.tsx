"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CORE_URL } from "@/lib/constants";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { Container } from "@talome/types";

interface ContainerLogsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: Container | null;
}

export function ContainerLogs({ open, onOpenChange, container }: ContainerLogsProps) {
  const isMobile = useIsMobile();
  const [state, setState] = useState<{ containerId: string; logs: string; loading: boolean }>({
    containerId: "",
    logs: "",
    loading: false,
  });

  useEffect(() => {
    if (!open || !container) return;

    fetch(`${CORE_URL}/api/containers/${container.id}/logs?tail=200`)
      .then((res) => res.text())
      .then((text) => {
        setState({ containerId: container.id, logs: text, loading: false });
      })
      .catch(() => {
        setState({ containerId: container.id, logs: "Failed to fetch logs.", loading: false });
      });
  }, [open, container]);

  if (!container) return null;

  const loading = state.containerId !== container.id ? true : state.loading;
  const logs = state.containerId !== container.id ? "" : state.logs;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "w-full overflow-hidden",
          isMobile ? "h-[92svh] rounded-t-xl" : "sm:max-w-xl"
        )}
      >
        <SheetHeader>
          <SheetTitle className="font-medium">{container.name} — Logs</SheetTitle>
          <SheetDescription>{container.image}</SheetDescription>
        </SheetHeader>
        <ScrollArea className={cn("mt-4", isMobile ? "h-[calc(92svh-6rem)]" : "h-[calc(100vh-8rem)]")}>
          {loading ? (
            <div className="grid gap-2 p-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : (
            <pre className="rounded-lg bg-muted p-4 text-sm font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap break-all overflow-hidden">
              {logs || "No logs available."}
            </pre>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
