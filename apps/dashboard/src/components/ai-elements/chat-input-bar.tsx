"use client";

import type { ChatStatus, FileUIPart } from "ai";
import type { ReactNode } from "react";
import { useCallback } from "react";
import Image from "next/image";
import { toast } from "sonner";
import {
  HugeiconsIcon,
  FileAttachmentIcon,
  Cancel01Icon,
  Image01Icon,
} from "@/components/icons";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";

// ── Attachment preview ──────────────────────────────────────────────────────

function AttachmentPreviewList() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith("image/");

        return (
          <div
            key={file.id}
            className="flex max-w-full items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-2.5 py-2"
          >
            {isImage && file.url ? (
              <Image
                alt={file.filename || "Attachment preview"}
                className="size-10 shrink-0 rounded-lg object-cover"
                src={file.url}
                unoptimized
                width={40}
                height={40}
              />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <HugeiconsIcon
                  icon={isImage ? Image01Icon : FileAttachmentIcon}
                  size={16}
                />
              </div>
            )}

            <div className="min-w-0">
              <div className="truncate text-xs font-medium">
                {file.filename || "Attachment"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {isImage ? "Image" : file.mediaType || "File"}
              </div>
            </div>

            <button
              aria-label={`Remove ${file.filename || "attachment"}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => attachments.remove(file.id)}
              type="button"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Shared input bar ────────────────────────────────────────────────────────

export interface ChatInputBarProps {
  status: ChatStatus;
  onSubmit: (message: { text: string; files: FileUIPart[] }) => void | Promise<void>;
  onStop?: () => void;
  placeholder?: string;
  extraTools?: ReactNode;
  maxWidth?: string;
}

export function ChatInputBar({
  status,
  onSubmit,
  onStop,
  placeholder = "Ask Talome anything...",
  extraTools,
  maxWidth = "max-w-2xl",
}: ChatInputBarProps) {
  const isActive = status === "streaming" || status === "submitted";

  const handleError = useCallback(
    (err: { code: string; message: string }) => toast.error(err.message),
    [],
  );

  return (
    <div
      className="relative shrink-0 pb-3 pt-2"
    >
      <div className={`${maxWidth} mx-auto w-full px-4 sm:px-6`}>
        <PromptInput
          className="prompt-input"
          maxFileSize={5 * 1024 * 1024}
          maxFiles={5}
          multiple
          onError={handleError}
          onSubmit={onSubmit}
        >
          <AttachmentPreviewList />
          <PromptInputTextarea placeholder={placeholder} />
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger tooltip="Add files or images" />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              {extraTools}
            </PromptInputTools>
            <PromptInputSubmit
              status={status}
              onStop={onStop}
              disabled={isActive && status !== "streaming"}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
