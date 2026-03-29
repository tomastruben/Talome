"use client";

import Image from "next/image";
import { useEffect, useState, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { terminalOpenAtom, terminalCommandAtom } from "@/atoms/terminal";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  HugeiconsIcon,
  Home01Icon,
  Film01Icon,
  Tv01Icon,
  DownloadSquare01Icon,
  HardDriveIcon,
  Settings01Icon,
  Activity01Icon,
  Package01Icon,
  Message01Icon,
  FlashIcon,
  ComputerTerminal01Icon,
  Add01Icon,
  ArrowLeft01Icon,
  ExpandIcon,
  Orbit01Icon,
  Bug01Icon,
  AudioBook01Icon,
  Download01Icon,
  Tick01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
const loadToPng = () => import("html-to-image").then((m) => m.toPng);
import { useBugHunt } from "@/components/bug-hunt/bug-hunt-context";
import { useBugContext } from "@/hooks/use-bug-context";
import { useAssistant } from "./assistant-context";
import { AssistantChatError } from "./chat-error";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useInstalledApps } from "@/hooks/use-installed-apps";
import { useUnifiedSearch } from "@/hooks/use-unified-search";
import { TerminalSheet } from "@/components/terminal/terminal-sheet";
import { ChatMessage } from "@/components/chat/chat-message";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CORE_URL } from "@/lib/constants";
import { Skeleton } from "@/components/ui/skeleton";
import { usePathname } from "next/navigation";
import type { Container, ServiceStack, SearchResult } from "@talome/types";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { QUALITY_TIERS, type QualityTier } from "@talome/types";
import type { MediaSearchResult } from "@talome/types";

// ── Nav commands ──────────────────────────────────────────────────────────────

interface NavCommand {
  label: string;
  path: string;
  icon: IconSvgElement;
  shortcut?: string;
}

const NAV_COMMANDS: NavCommand[] = [
  { label: "Home",        path: "/dashboard",            icon: Home01Icon,          shortcut: "⌘1" },
  { label: "Media",       path: "/dashboard/media",      icon: Film01Icon,          shortcut: "⌘2" },
  { label: "Services",    path: "/dashboard/containers", icon: Package01Icon,       shortcut: "⌘3" },
  { label: "App Store",   path: "/dashboard/apps",       icon: DownloadSquare01Icon,shortcut: "⌘4" },
  { label: "Files",       path: "/dashboard/files",      icon: HardDriveIcon,       shortcut: "⌘5" },
  { label: "Automations", path: "/dashboard/automations",icon: FlashIcon,           shortcut: "⌘6" },
  { label: "Intelligence", path: "/dashboard/intelligence", icon: Activity01Icon,     shortcut: "⌘7" },
  { label: "Settings",    path: "/dashboard/settings",   icon: Settings01Icon,      shortcut: "⌘," },
];

// ── Service icon (small, for command items) ──────────────────────────────────

function ServiceIcon({ iconUrl, icon, name }: { iconUrl?: string; icon?: string; name?: string }) {
  const realUrl = iconUrl && !iconUrl.startsWith("file://") ? iconUrl : null;
  return (
    <div className="relative size-5 rounded-md bg-muted/50 border border-border/30 flex items-center justify-center overflow-hidden shrink-0">
      {realUrl ? (
        <>
          <Image
            src={realUrl}
            alt={name ? `${name} icon` : ""}
            className="object-cover" fill
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              img.style.display = "none";
              img.nextElementSibling?.classList.remove("hidden");
            }}
          />
          <span className="hidden text-xs">{icon || "📦"}</span>
        </>
      ) : icon && icon !== "📦" ? (
        <span className="text-xs">{icon}</span>
      ) : (
        <HugeiconsIcon icon={Package01Icon} size={11} className="text-dim-foreground" />
      )}
    </div>
  );
}

interface LaunchableService {
  id: string;
  name: string;
  icon?: string;
  iconUrl?: string;
  container: Container;
}

function extractLaunchable(stacks: ServiceStack[]): LaunchableService[] {
  const result: LaunchableService[] = [];
  for (const stack of stacks) {
    for (const container of stack.containers) {
      if (container.status !== "running") continue;
      if (!container.ports.some((p) => p.protocol === "tcp" && p.host > 0)) continue;
      const ci = stack.containerIcons?.[container.id];
      result.push({
        id: container.id,
        name: ci?.name ?? (stack.containers.length === 1 ? stack.name : container.name),
        icon: ci?.icon ?? stack.icon,
        iconUrl: ci?.iconUrl ?? stack.iconUrl,
        container,
      });
    }
  }
  return result;
}

// ── Thinking dots ─────────────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-2 px-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-foreground/30"
          style={{
            animation: "thinking-dot 1.4s ease-in-out infinite",
            animationDelay: `${i * 150}ms`,
          }}
        />
      ))}
    </div>
  );
}

// ── Chat input ────────────────────────────────────────────────────────────────

function ChatInput({
  onSubmit,
  disabled,
  isStreaming,
  onStop,
  prefill,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  prefill?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill && textareaRef.current) {
      textareaRef.current.value = prefill;
      textareaRef.current.dispatchEvent(new Event("input", { bubbles: true }));
      textareaRef.current.focus();
    }
  }, [prefill]);

  // Auto-focus when mounted
  useEffect(() => {
    if (!prefill) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [prefill]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const val = e.currentTarget.value.trim();
      if (val) {
        onSubmit(val);
        e.currentTarget.value = "";
        e.currentTarget.style.height = "auto";
      }
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const handleButtonClick = () => {
    if (isStreaming && onStop) { onStop(); return; }
    const val = textareaRef.current?.value.trim();
    if (val) {
      onSubmit(val);
      textareaRef.current!.value = "";
      textareaRef.current!.style.height = "auto";
    }
  };

  return (
    <div className="flex items-end gap-2 px-3 py-2.5 border-t border-border/60">
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder="Ask Talome anything..."
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onChange={handleInput}
        className="flex-1 resize-none bg-transparent text-lg md:text-sm placeholder:text-muted-foreground focus:outline-none min-h-[24px] max-h-[160px] leading-relaxed disabled:opacity-40"
      />
      <button
        type="button"
        onClick={handleButtonClick}
        disabled={!isStreaming && disabled}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors mb-px",
          isStreaming
            ? "bg-foreground text-background hover:bg-foreground/80"
            : "bg-foreground text-background hover:bg-foreground/80 disabled:opacity-30 disabled:pointer-events-none"
        )}
      >
        {isStreaming ? (
          <svg viewBox="0 0 12 12" className="size-3" fill="currentColor">
            <rect x="2" y="2" width="8" height="8" rx="1" />
          </svg>
        ) : disabled ? (
          <Spinner className="size-3.5" />
        ) : (
          <svg viewBox="0 0 14 14" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 11V3M3 7l4-4 4 4" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ── Service Quick Look ────────────────────────────────────────────────────────
// (Moved to /components/quick-look/quick-look.tsx — a full-viewport modal
//  accessible from anywhere: palette, services page, home dashboard widget.)

// ── Palette ───────────────────────────────────────────────────────────────────

type PaletteMode = "search" | "chat" | "media-detail";

/** Data for the inline media detail view (non-library items). */
interface MediaDetailState {
  title: string;
  year: number;
  type: "movie" | "tv";
  overview: string;
  poster: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PaletteMode>("search");
  const [query, setQuery] = useState("");
  const [chatPrefill, setChatPrefill] = useState<string | undefined>(undefined);
  const [mediaDetail, setMediaDetail] = useState<MediaDetailState | null>(null);
  const [addState, setAddState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [addError, setAddError] = useState("");
  const [addedServiceId, setAddedServiceId] = useState<number | null>(null);
  const [qualityTier, setQualityTier] = useState<QualityTier>("standard");
  const [terminalOpen, setTerminalOpen] = useAtom(terminalOpenAtom);
  const [terminalCommand, setTerminalCommand] = useAtom(terminalCommandAtom);
  const router = useRouter();
  const pathname = usePathname();
  const bugHunt = useBugHunt();
  const { captureContext } = useBugContext();
  const {
    handleSubmit,
    startNew,
    messages,
    status,
    error,
    clearError,
    stop,
    addToolApprovalResponse,
    regenerate,
    registerOpenPalette,
  } = useAssistant();
  const quickLook = useQuickLook();


  const isActive = status === "streaming" || status === "submitted";
  const isStreaming = status === "streaming";
  const hasMessages = messages.length > 0;
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom when messages change
  useEffect(() => {
    const el = chatScrollRef.current;
    if (mode === "chat" && el) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
  }, [mode, messages, isActive]);

  // Live data — only fetched when palette is open
  const { stacks } = useServiceStacks();
  const launchableServices = extractLaunchable(stacks);
  const { apps: installedApps } = useInstalledApps(open);

  // Unified entity search — fires after 3+ chars with debounce
  const { results: searchResults, isSearching } = useUnifiedSearch(
    open && mode === "search" && query.length >= 3 ? query : "",
  );
  const mediaResults = searchResults.filter((r): r is SearchResult & { kind: "media" } => r.kind === "media");
  const appResults = searchResults.filter((r): r is SearchResult & { kind: "app" } => r.kind === "app");
  const containerResults = searchResults.filter((r): r is SearchResult & { kind: "container" } => r.kind === "container");
  const audiobookResults = searchResults.filter((r): r is SearchResult & { kind: "audiobook" } => r.kind === "audiobook");
  const automationResults = searchResults.filter((r): r is SearchResult & { kind: "automation" } => r.kind === "automation");
  const hasEntityResults = searchResults.length > 0;

  // Register the open-in-chat-mode function so external callers can trigger it
  const openInChatMode = useCallback((prefill?: string) => {
    setChatPrefill(prefill);
    setMode("chat");
    setOpen(true);
  }, []);

  useEffect(() => {
    registerOpenPalette(openInChatMode);
  }, [registerOpenPalette, openInChatMode]);

  // Reset to search mode when closed
  const handleOpenChange = useCallback((v: boolean) => {
    setOpen(v);
    if (!v) {
      setQuery("");
      setMode("search");
      setChatPrefill(undefined);
      setMediaDetail(null);
      setAddState("idle");
      setAddError("");
      setAddedServiceId(null);
    }
  }, []);

  // Cmd+K / Ctrl+K to toggle — always opens in search mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => {
          if (!v) {
            setMode("search");
          }
          return !v;
        });
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // "/" shortcut — opens directly in chat mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setMode("chat");
        setOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const navigate = useCallback(
    (path: string) => {
      handleOpenChange(false);
      router.push(path);
    },
    [router, handleOpenChange]
  );

  const switchToChatMode = useCallback(
    async (text: string) => {
      setQuery("");
      setMode("chat");
      await handleSubmit(text, `Current page: ${pathname}`);
    },
    [handleSubmit, pathname]
  );

  const onChatSubmit = useCallback(
    async (text: string) => {
      setChatPrefill(undefined);
      await handleSubmit(text, `Current page: ${pathname}`);
    },
    [handleSubmit, pathname]
  );

  const openTerminal = useCallback(() => {
    handleOpenChange(false);
    setTerminalOpen(true);
  }, [handleOpenChange, setTerminalOpen]);

  const newConversation = useCallback(() => {
    startNew();
    setMode("chat");
  }, [startNew]);

  const openFullScreen = useCallback(() => {
    handleOpenChange(false);
    router.push(`/dashboard/assistant?from=${encodeURIComponent(pathname)}`);
  }, [handleOpenChange, router, pathname]);

  // Fallback to assistant on Enter with no matching nav
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && query.trim()) {
      const matches = NAV_COMMANDS.filter((c) =>
        c.label.toLowerCase().includes(query.toLowerCase())
      );
      if (matches.length === 0) {
        switchToChatMode(query);
      }
    }
  };

  const hasQuery = query.trim().length > 0;

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        showCloseButton={false}
      >
        {mode === "chat" ? (
          // ── Chat mode ──────────────────────────────────────────────────────
          // This is a quick, ephemeral exchange — palette height matches search mode.
          // For sustained conversation with full history, use the Assistant page.
          <div className="flex flex-col" style={{ maxHeight: "min(420px, calc(100svh - 8rem))" }}>
            {/* Chat header — same height as CommandInput (h-12) */}
            <div className="flex h-12 items-center gap-1 px-2 border-b border-border shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-dim-foreground hover:text-foreground"
                onClick={() => { setMode("search"); setQuery(""); }}
                aria-label="Back to search"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
              </Button>
              <HugeiconsIcon
                icon={Orbit01Icon}
                size={15}
                className="text-dim-foreground shrink-0"
              />
              <span className="flex-1 text-sm text-muted-foreground pl-0.5">
                {hasMessages ? "Assistant" : "Ask anything"}
              </span>
              {hasMessages && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-dim-foreground hover:text-foreground"
                  onClick={newConversation}
                  title="New conversation"
                  aria-label="New conversation"
                >
                  <HugeiconsIcon icon={Add01Icon} size={13} />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-dim-foreground hover:text-foreground"
                onClick={openFullScreen}
                title="Open in full screen"
                aria-label="Open in full screen"
              >
                <HugeiconsIcon icon={ExpandIcon} size={13} />
              </Button>
            </div>

            {/* Messages — only the last user+assistant exchange to keep it lightweight.
                The full page (/assistant) is where you go for sustained conversation. */}
            {hasMessages ? (
              <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto">
                <div className="py-3 px-3.5 flex flex-col gap-3">
                  {error && <AssistantChatError error={error} onDismiss={clearError} />}
                  {messages.slice(-4).map((message, index, arr) => (
                    <ChatMessage
                      key={`${message.id}-${index}`}
                      message={message}
                      addToolApprovalResponse={addToolApprovalResponse}
                      onRegenerate={regenerate}
                      isLast={index === arr.length - 1}
                    />
                  ))}
                  {isActive && messages[messages.length - 1]?.role === "user" && (
                    <ThinkingDots />
                  )}
                </div>
                {/* Expand affordance — only shown when there's more than the last exchange */}
                {messages.length > 4 && (
                  <button
                    onClick={openFullScreen}
                    className="w-full flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors border-t border-border/40"
                  >
                    <HugeiconsIcon icon={ExpandIcon} size={12} className="shrink-0" />
                    <span>{messages.length - 4} earlier messages — open in Assistant</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center py-8">
                <div className="w-full px-3.5">
                  {error ? (
                    <AssistantChatError error={error} onDismiss={clearError} />
                  ) : (
                    <p className="text-xs text-center text-muted-foreground">
                      Ask anything about your server
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Input */}
            <ChatInput
              onSubmit={onChatSubmit}
              disabled={status === "submitted"}
              isStreaming={isStreaming}
              onStop={stop}
              prefill={chatPrefill}
            />
          </div>
        ) : mode === "media-detail" && mediaDetail ? (
          // ── Media detail mode (inline add-to-library) ──────────────────────
          <div className="flex flex-col" style={{ maxHeight: "min(420px, calc(100svh - 8rem))" }}>
            {/* Header */}
            <div className="flex h-12 items-center gap-2 px-3 border-b border-border shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-dim-foreground hover:text-foreground"
                onClick={() => { setMode("search"); setMediaDetail(null); setAddState("idle"); }}
                aria-label="Back to search"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
              </Button>
              <HugeiconsIcon
                icon={mediaDetail.type === "tv" ? Tv01Icon : Film01Icon}
                size={15}
                className="text-dim-foreground shrink-0"
              />
              <span className="flex-1 text-sm truncate">{mediaDetail.title}</span>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="flex gap-4">
                {/* Poster */}
                <div className="relative w-[80px] h-[120px] rounded-lg bg-muted/50 overflow-hidden shrink-0">
                  {mediaDetail.poster ? (
                    <Image
                      src={mediaDetail.poster}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="80px"
                      unoptimized
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <HugeiconsIcon
                        icon={mediaDetail.type === "tv" ? Tv01Icon : Film01Icon}
                        size={24}
                        className="text-muted-foreground"
                      />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-medium leading-tight">{mediaDetail.title}</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    {mediaDetail.year > 0 ? `${mediaDetail.year} · ` : ""}{mediaDetail.type === "tv" ? "TV Show" : "Movie"}
                  </p>
                  {mediaDetail.overview && (
                    <p className="text-xs text-muted-foreground mt-2 line-clamp-3 leading-relaxed">
                      {mediaDetail.overview}
                    </p>
                  )}
                </div>
              </div>

              {/* Quality tier selector */}
              {addState !== "done" && (
                <div className="mt-4 space-y-1">
                  {QUALITY_TIERS.map((tier) => (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => setQualityTier(tier.id)}
                      disabled={addState === "loading"}
                      className={cn(
                        "w-full flex items-center justify-between rounded-lg px-3 py-2 text-left transition-colors",
                        qualityTier === tier.id
                          ? "bg-muted/60 text-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
                      )}
                    >
                      <span className="text-sm font-medium">{tier.label}</span>
                      <span className="text-xs text-muted-foreground">{tier.hint}</span>
                    </button>
                  ))}
                </div>
              )}

              {addError && (
                <p className="text-xs text-destructive mt-2">{addError}</p>
              )}
            </div>

            {/* Footer — add button */}
            <div className="px-4 py-3 border-t border-border">
              {addState === "done" && addedServiceId && mediaDetail && (
                <Button
                  variant="outline"
                  className="w-full gap-2 mb-2"
                  onClick={() => {
                    handleOpenChange(false);
                    router.push(`/dashboard/media/${mediaDetail.type === "tv" ? "tv" : "movie"}/${addedServiceId}`);
                  }}
                >
                  <HugeiconsIcon icon={Film01Icon} size={14} />
                  View in library
                </Button>
              )}
              <Button
                className="w-full gap-2"
                disabled={addState === "loading" || addState === "done"}
                onClick={async () => {
                  setAddState("loading");
                  setAddError("");
                  try {
                    const res = await fetch(`${CORE_URL}/api/media/add`, {
                      method: "POST",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        type: mediaDetail.type,
                        title: mediaDetail.title,
                        tmdbId: mediaDetail.tmdbId ?? undefined,
                        tvdbId: mediaDetail.tvdbId ?? undefined,
                        qualityTier,
                      }),
                    });
                    if (!res.ok) {
                      const j: { error?: string } = await res.json().catch(() => ({}));
                      throw new Error(j.error ?? `HTTP ${res.status}`);
                    }
                    const data = await res.json().catch(() => ({})) as { serviceId?: number };
                    setAddedServiceId(data.serviceId ?? null);
                    setAddState("done");
                  } catch (err: unknown) {
                    setAddError(err instanceof Error ? err.message : "Failed to add");
                    setAddState("error");
                  }
                }}
              >
                {addState === "loading" ? (
                  <Spinner className="size-3.5" />
                ) : addState === "done" ? (
                  <HugeiconsIcon icon={Tick01Icon} size={14} />
                ) : (
                  <HugeiconsIcon icon={Download01Icon} size={14} />
                )}
                {addState === "done"
                  ? "Added to library"
                  : addState === "loading"
                  ? "Adding…"
                  : "Add to library"}
              </Button>
            </div>
          </div>
        ) : (
          // ── Search mode ────────────────────────────────────────────────────
          <>
            <CommandInput
              placeholder="Search or ask Talome..."
              value={query}
              onValueChange={setQuery}
              onKeyDown={handleSearchKeyDown}
            />
            <CommandList className="max-h-[420px]">
              <CommandEmpty>
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left hover:bg-accent/50 transition-colors"
                  onClick={() => switchToChatMode(query)}
                >
                  <HugeiconsIcon icon={Orbit01Icon} size={15} className="shrink-0 text-dim-foreground" />
                  <span className="truncate">{query || "Ask Talome anything…"}</span>
                </button>
              </CommandEmpty>

              {/* Ask Talome — always first, prominent */}
              <CommandGroup heading="Ask Talome">
                <CommandItem
                  value={hasQuery ? `ask: ${query}` : "ask talome open assistant"}
                  onSelect={() => hasQuery ? switchToChatMode(query) : openInChatMode()}
                  className="group"
                >
                  <HugeiconsIcon icon={Orbit01Icon} size={15} className="shrink-0 text-dim-foreground" />
                  {hasQuery ? (
                    <span className="flex-1 min-w-0">
                      <span className="text-muted-foreground">Ask: </span>
                      <span className="truncate">{query}</span>
                    </span>
                  ) : (
                    <span className="flex-1 text-muted-foreground">
                      Ask Talome anything
                      {isActive && (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs text-primary/70">
                          <span className="relative flex size-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
                            <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                          </span>
                          thinking…
                        </span>
                      )}
                    </span>
                  )}
                  <CommandShortcut>/</CommandShortcut>
                </CommandItem>
              </CommandGroup>

              {/* Entity search results — appear when query is 3+ chars */}
              {hasQuery && (mediaResults.length > 0 || audiobookResults.length > 0 || containerResults.length > 0 || automationResults.length > 0 || appResults.length > 0 || isSearching) && (
                <>
                  <CommandSeparator />

                  {/* Media */}
                  {mediaResults.length > 0 && (
                    <CommandGroup heading="Media" forceMount>
                      {mediaResults.map((r) => {
                        const posterSrc = r.poster
                          ? (r.poster.startsWith("/api/") ? `${CORE_URL}${r.poster}` : r.poster)
                          : null;
                        return (
                          <CommandItem
                            key={r.id}
                            value={`media ${r.type} ${r.name} ${r.year} ${r.id}`}
                            onSelect={() => {
                              if (r.inLibrary) {
                                navigate(
                                  r.type === "tv"
                                    ? `/dashboard/media/tv/${r.serviceId}`
                                    : `/dashboard/media/movie/${r.serviceId}`
                                );
                              } else {
                                // Not in library — show inline detail view
                                setMediaDetail({
                                  title: r.name,
                                  year: r.year,
                                  type: r.type,
                                  overview: r.overview,
                                  poster: posterSrc,
                                  tmdbId: r.tmdbId,
                                  tvdbId: r.tvdbId,
                                });
                                setAddState("idle");
                                setAddError("");
                                setAddedServiceId(null);
                                setQualityTier("standard");
                                setMode("media-detail");
                              }
                            }}
                            className="gap-3"
                          >
                            {/* Poster thumbnail */}
                            <div className="relative size-8 rounded-[4px] bg-muted/50 overflow-hidden shrink-0 flex items-center justify-center">
                              {posterSrc ? (
                                <Image
                                  src={posterSrc}
                                  alt=""
                                  fill
                                  className="object-cover"
                                  sizes="32px"
                                  unoptimized
                                />
                              ) : (
                                <HugeiconsIcon
                                  icon={r.type === "tv" ? Tv01Icon : Film01Icon}
                                  size={14}
                                  className="text-muted-foreground"
                                />
                              )}
                            </div>
                            <span className="flex-1 min-w-0 truncate">{r.name}</span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              {r.inLibrary ? (
                                <span className="text-[10px] font-medium text-status-healthy bg-status-healthy/10 px-1.5 py-0.5 rounded-full leading-none">
                                  In Library
                                </span>
                              ) : (
                                <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full leading-none">
                                  Add
                                </span>
                              )}
                              {r.rating != null && r.rating > 0 && (
                                <span className="text-[10px] text-amber-400">{r.rating.toFixed(1)}</span>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {r.year > 0 ? `${r.year} · ` : ""}{r.type === "tv" ? "TV" : "Movie"}
                              </span>
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}

                  {/* Audiobooks */}
                  {audiobookResults.length > 0 && (
                    <CommandGroup heading="Audiobooks" forceMount>
                      {audiobookResults.map((r) => (
                        <CommandItem
                          key={r.id}
                          value={`audiobook ${r.name} ${r.author}`}
                          onSelect={() => navigate(`/dashboard/audiobooks/${r.id}`)}
                          className="gap-3"
                        >
                          {/* Cover thumbnail */}
                          <div className="relative size-8 rounded-[4px] bg-muted/50 overflow-hidden shrink-0 flex items-center justify-center">
                            {r.cover ? (
                              <Image
                                src={r.cover.startsWith("/api/") ? `${CORE_URL}${r.cover}` : r.cover}
                                alt=""
                                fill
                                className="object-cover"
                                sizes="32px"
                                unoptimized
                              />
                            ) : (
                              <HugeiconsIcon icon={AudioBook01Icon} size={14} className="text-muted-foreground" />
                            )}
                          </div>
                          <span className="flex-1 min-w-0 truncate">{r.name}</span>
                          {r.author && (
                            <span className="text-xs text-muted-foreground shrink-0 max-w-[140px] truncate">
                              {r.author}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Containers */}
                  {containerResults.length > 0 && (
                    <CommandGroup heading="Containers" forceMount>
                      {containerResults.map((r) => (
                        <CommandItem
                          key={r.id}
                          value={`container ${r.name}`}
                          onSelect={() => navigate(`/dashboard/containers?highlight=${r.id}`)}
                        >
                          <HugeiconsIcon
                            icon={Package01Icon}
                            size={15}
                            className="shrink-0 text-dim-foreground"
                          />
                          <span className="flex-1 min-w-0 truncate">{r.name}</span>
                          <span className={cn(
                            "text-xs shrink-0",
                            r.status === "running" ? "text-status-healthy" : "text-muted-foreground"
                          )}>
                            {r.status}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Apps from catalog */}
                  {appResults.length > 0 && (
                    <CommandGroup heading="App Store" forceMount>
                      {appResults.map((r) => (
                        <CommandItem
                          key={`${r.storeId}-${r.id}`}
                          value={`app store ${r.name}`}
                          onSelect={() => navigate(`/dashboard/apps/${r.storeId}/${r.id}`)}
                        >
                          {r.icon && r.icon !== "📦" ? (
                            <span className="text-sm shrink-0">{r.icon}</span>
                          ) : (
                            <HugeiconsIcon icon={DownloadSquare01Icon} size={15} className="shrink-0 text-dim-foreground" />
                          )}
                          <span className="flex-1 min-w-0 truncate">{r.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {r.installed ? "Installed" : r.category}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Automations */}
                  {automationResults.length > 0 && (
                    <CommandGroup heading="Automations" forceMount>
                      {automationResults.map((r) => (
                        <CommandItem
                          key={r.id}
                          value={`automation ${r.name}`}
                          onSelect={() => navigate(`/dashboard/automations?id=${r.id}`)}
                        >
                          <HugeiconsIcon
                            icon={FlashIcon}
                            size={15}
                            className="shrink-0 text-dim-foreground"
                          />
                          <span className="flex-1 min-w-0 truncate">{r.name}</span>
                          <span className={cn(
                            "text-xs shrink-0",
                            r.enabled ? "text-muted-foreground" : "text-muted-foreground/50"
                          )}>
                            {r.enabled ? "Active" : "Disabled"}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Loading skeleton — shows while remote results arrive */}
                  {isSearching && searchResults.length === 0 && (
                    <CommandGroup heading="Searching…" forceMount>
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="flex items-center gap-3 px-2 py-1.5">
                          <Skeleton className="size-8 rounded-[4px] shrink-0" />
                          <Skeleton className="h-3.5 flex-1 rounded" />
                          <Skeleton className="h-3 w-16 rounded shrink-0" />
                        </div>
                      ))}
                    </CommandGroup>
                  )}
                </>
              )}

              <CommandSeparator />

              {/* Navigate */}
              <CommandGroup heading="Navigate">
                {NAV_COMMANDS.map((cmd) => (
                  <CommandItem
                    key={cmd.path}
                    value={cmd.label}
                    onSelect={() => navigate(cmd.path)}
                  >
                    <HugeiconsIcon
                      icon={cmd.icon}
                      size={15}
                      className="shrink-0 text-dim-foreground"
                    />
                    {cmd.label}
                    {cmd.shortcut && (
                      <CommandShortcut>{cmd.shortcut}</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>

              {/* Launchpad — only services with a web interface */}
              {launchableServices.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Open">
                    {launchableServices.map((svc) => (
                      <CommandItem
                        key={svc.id}
                        value={`service ${svc.name}`}
                        onSelect={() => {
                          handleOpenChange(false);
                          quickLook.open(svc.container);
                        }}
                      >
                        <ServiceIcon iconUrl={svc.iconUrl} icon={svc.icon} name={svc.name} />
                        <span className="flex-1 truncate">{svc.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              {/* Installed apps */}
              {hasQuery && installedApps.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Apps">
                    {installedApps.map((app) => (
                      <CommandItem
                        key={app.id}
                        value={`app ${app.name}`}
                        onSelect={() =>
                          navigate(`/dashboard/apps/${app.storeId}/${app.id}`)
                        }
                      >
                        <HugeiconsIcon
                          icon={DownloadSquare01Icon}
                          size={15}
                          className="shrink-0 text-dim-foreground"
                        />
                        <span className="flex-1 truncate">{app.name}</span>
                        <span className="text-xs text-muted-foreground capitalize">
                          {app.installed?.status ?? "installed"}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              {/* Actions */}
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem value="open terminal" onSelect={openTerminal}>
                  <HugeiconsIcon
                    icon={ComputerTerminal01Icon}
                    size={15}
                    className="shrink-0 text-dim-foreground"
                  />
                  Open Terminal
                  <CommandShortcut>⌘T</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="new automation"
                  onSelect={() => navigate("/dashboard/automations")}
                >
                  <HugeiconsIcon
                    icon={Add01Icon}
                    size={15}
                    className="shrink-0 text-dim-foreground"
                  />
                  New Automation
                </CommandItem>
                <CommandItem
                  value="new conversation"
                  onSelect={() => { newConversation(); }}
                >
                  <HugeiconsIcon
                    icon={Message01Icon}
                    size={15}
                    className="shrink-0 text-dim-foreground"
                  />
                  New Conversation
                </CommandItem>
                <CommandItem
                  value="bug hunt report bug"
                  onSelect={async () => {
                    setOpen(false);
                    // Capture screenshot while palette close animates
                    let screenshotData: string | null = null;
                    try {
                      const target = document.querySelector("main") as HTMLElement | null ?? document.body;
                      const toPng = await loadToPng();
                      screenshotData = await toPng(target, { quality: 0.8, pixelRatio: 1 });
                    } catch { /* optional */ }
                    const ctx = captureContext();
                    bugHunt.open({ screenshot: screenshotData ?? undefined, context: ctx });
                  }}
                >
                  <HugeiconsIcon
                    icon={Bug01Icon}
                    size={15}
                    className="shrink-0 text-dim-foreground"
                  />
                  Bug Hunt
                  <CommandShortcut>⇧⌘X</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </>
        )}
      </CommandDialog>

      <TerminalSheet
        open={terminalOpen}
        onOpenChange={(v) => { setTerminalOpen(v); if (!v) setTerminalCommand(null); }}
        initialCommand={terminalCommand}
      />

    </>
  );
}
