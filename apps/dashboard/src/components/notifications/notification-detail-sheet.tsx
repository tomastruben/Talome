"use client";

import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HugeiconsIcon, BubbleChatDownload02Icon } from "@/components/icons";
import { Streamdown } from "streamdown";
import { useAssistant } from "@/components/assistant/assistant-context";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

interface NotificationDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notification: {
    type: "info" | "warning" | "critical";
    title: string;
    fullBody: string;
    createdAt: string;
  } | null;
}

const TYPE_STYLES = {
  critical: "text-status-critical border-status-critical/30 bg-status-critical/5",
  warning: "text-status-warning border-status-warning/30 bg-status-warning/5",
  info: "text-muted-foreground border-border bg-muted/30",
};

export function NotificationDetailSheet({
  open,
  onOpenChange,
  notification,
}: NotificationDetailSheetProps) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const { handleSubmit } = useAssistant();

  if (!notification) return null;

  const askAssistant = () => {
    const userMessage = `Discuss this notification: **${notification.title}**`;
    const systemContext = [
      "Current page: /dashboard (notification detail)",
      `Notification type: ${notification.type}`,
      `Time: ${notification.createdAt}`,
      ...(notification.fullBody ? [
        "",
        "Full notification body:",
        notification.fullBody,
      ] : []),
    ].join("\n");

    void handleSubmit(userMessage, systemContext);
    onOpenChange(false);
    router.push("/dashboard/assistant");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "w-full flex flex-col p-0 gap-0 overflow-hidden",
          isMobile ? "h-[85svh] rounded-t-xl" : "sm:max-w-md",
        )}
      >
        <SheetHeader className="px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Badge
                  variant="outline"
                  className={cn("text-xs capitalize", TYPE_STYLES[notification.type])}
                >
                  {notification.type}
                </Badge>
                <SheetDescription className="text-xs tabular-nums" suppressHydrationWarning>
                  {new Date(notification.createdAt).toLocaleString()}
                </SheetDescription>
              </div>
              <SheetTitle className="text-base font-medium leading-snug">
                {notification.title}
              </SheetTitle>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-4">
            {notification.fullBody ? (
              <Streamdown className="text-sm text-muted-foreground leading-relaxed [&_strong]:text-foreground [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_p+p]:mt-3 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mt-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mt-2 [&_li]:mt-1 [&_h1]:text-foreground [&_h1]:font-medium [&_h1]:text-base [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-foreground [&_h2]:font-medium [&_h2]:text-sm [&_h2]:mt-3 [&_h2]:mb-1.5 [&_pre]:bg-muted/50 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:mt-2 [&_pre]:overflow-x-auto">
                {notification.fullBody}
              </Streamdown>
            ) : (
              <p className="text-sm text-muted-foreground">No additional details.</p>
            )}
          </div>
        </ScrollArea>

        <div className="shrink-0 px-5 py-3 border-t border-border/60">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2 text-xs"
            onClick={askAssistant}
          >
            <HugeiconsIcon icon={BubbleChatDownload02Icon} size={14} />
            Discuss with Assistant
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
