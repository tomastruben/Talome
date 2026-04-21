"use client";

import type { UIMessage } from "ai";
import type { ComponentProps, ComponentPropsWithoutRef, HTMLAttributes, ReactElement } from "react";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { MediaCodeTag } from "./media-code-tag";
import { HugeiconsIcon, ArrowLeft02Icon, ArrowRight02Icon } from "@/components/icons";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { useRouter } from "next/navigation";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { useContainers } from "@/hooks/use-containers";
import type { Container } from "@talome/types";
import { motion, useReducedMotion } from "motion/react";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[92%] sm:max-w-[85%] flex-col gap-1.5",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:overflow-hidden group-[.is-user]:rounded-2xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:overflow-x-auto group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <HugeiconsIcon icon={ArrowRight02Icon} size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mermaid version mismatch between @streamdown/mermaid and fumadocs-mermaid
const streamdownPlugins = { cjk, code, math, mermaid } as any;
const streamdownControls = { code: false, table: false } as const;
const MEDIA_TOOL_NAMES = new Set([
  "search_media",
  "request_media",
  "get_downloads",
  "get_calendar",
  "get_library",
]);
const CONTAINER_TOOL_NAMES = new Set([
  "list_containers",
  "get_container_logs",
  "check_service_health",
  "start_container",
  "stop_container",
  "restart_container",
]);
type ToolIntent = "unknown" | "media" | "containers" | "mixed";

function getTcpPorts(container: Container): number[] {
  return container.ports
    .filter((p) => p.protocol === "tcp" && p.host > 0)
    .map((p) => p.host)
    .filter((p, i, arr) => arr.indexOf(p) === i);
}

function normalizeContainerLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveContainerFromLink(
  href: string,
  linkText: string,
  containers: Container[]
): Container | null {
  let parsed: URL | null = null;
  try {
    parsed = new URL(href);
  } catch {
    parsed = null;
  }
  if (!parsed) return null;

  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (!isHttp) return null;

  const port = parsed?.port ? Number(parsed.port) : null;
  if (port && Number.isFinite(port) && port > 0) {
    const byPort = containers.find((c) => getTcpPorts(c).includes(port));
    if (byPort) return byPort;
  }

  const normalizedText = normalizeContainerLabel(linkText);
  if (!normalizedText) return null;
  return (
    containers.find((c) => normalizeContainerLabel(c.name) === normalizedText) ?? null
  );
}

function MessageLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { containers } = useContainers();
  const quickLook = useQuickLook();
  const router = useRouter();

  const textLabel =
    typeof children === "string"
      ? children
      : Array.isArray(children)
      ? children.filter((c): c is string => typeof c === "string").join("")
      : "";

  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        if (!href) return;

        // Internal dashboard navigation (e.g., file manager links)
        if (href.startsWith("/dashboard/")) {
          event.preventDefault();
          router.push(href);
          return;
        }

        const target = resolveContainerFromLink(href, textLabel, containers);
        if (!target) return;
        event.preventDefault();
        quickLook.open(target);
      }}
    >
      {children}
    </a>
  );
}

function inferToolIntent(toolContextNames?: string[]): ToolIntent {
  if (!toolContextNames || toolContextNames.length === 0) {
    return "unknown";
  }

  let hasMedia = false;
  let hasContainers = false;
  for (const toolName of toolContextNames) {
    if (MEDIA_TOOL_NAMES.has(toolName)) hasMedia = true;
    if (CONTAINER_TOOL_NAMES.has(toolName)) hasContainers = true;
  }

  if (hasMedia && hasContainers) return "mixed";
  if (hasMedia) return "media";
  if (hasContainers) return "containers";
  return "unknown";
}

export const MessageResponse = memo(
  ({ className, toolContextNames, ...props }: MessageResponseProps & { toolContextNames?: string[] }) => {
    const toolIntent = useMemo(() => inferToolIntent(toolContextNames), [toolContextNames]);
    const streamdownComponents = useMemo(
      () => ({
        code: (codeProps: ComponentPropsWithoutRef<"code"> & { node?: unknown }) => (
          <MediaCodeTag {...codeProps} toolIntent={toolIntent} />
        ),
        a: MessageLink,
        // Override streamdown's list-inside positioning — keep numbers in the margin
        ol: ({ node: _node, ...olProps }: ComponentPropsWithoutRef<"ol"> & { node?: unknown }) => (
          <ol {...olProps} className={cn("list-outside list-decimal", olProps.className)} />
        ),
        ul: ({ node: _node, ...ulProps }: ComponentPropsWithoutRef<"ul"> & { node?: unknown }) => (
          <ul {...ulProps} className={cn("list-outside list-disc", ulProps.className)} />
        ),
        li: ({ node: _node, ...liProps }: ComponentPropsWithoutRef<"li"> & { node?: unknown }) => (
          <li {...liProps} className={cn("[&>p]:inline", liProps.className)} />
        ),
      }),
      [toolIntent]
    );

    return (
      <Streamdown
        className={cn("chat-response size-full", className)}
        plugins={streamdownPlugins}
        components={streamdownComponents}
        controls={streamdownControls}
        {...props}
      />
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

MessageResponse.displayName = "MessageResponse";

export type MessageSourcesProps = {
  sources: { sourceId: string; url: string; title?: string }[];
  className?: string;
  animateIn?: boolean;
};

export const MessageSources = ({ sources, className, animateIn = false }: MessageSourcesProps) => {
  const prefersReducedMotion = useReducedMotion();
  if (sources.length === 0) return null;

  const animationProps =
    animateIn && !prefersReducedMotion
      ? {
          initial: { opacity: 0, y: 6, filter: "blur(2px)" },
          animate: { opacity: 1, y: 0, filter: "blur(0px)" },
          transition: {
            duration: 0.38,
            delay: 0.18,
            ease: [0.22, 1, 0.36, 1] as const,
          },
        }
      : {};

  return (
    <motion.div className={cn("mt-3 space-y-1.5", className)} {...animationProps}>
      <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Sources
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s, i) => {
          let hostname = s.url;
          try { hostname = new URL(s.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
          return (
            <a
              key={s.sourceId}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/60 hover:text-foreground"
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-muted/60 text-xs font-medium tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <span className="max-w-[160px] truncate">{s.title || hostname}</span>
            </a>
          );
        })}
      </div>
    </motion.div>
  );
};

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
