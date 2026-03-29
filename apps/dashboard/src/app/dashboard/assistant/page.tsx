"use client";

import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ChatStatus, FileUIPart } from "ai";
import { useAtom, useSetAtom } from "jotai";
import {
  HugeiconsIcon,
  Delete01Icon,
  KeyboardIcon,
  LayoutAlignLeftIcon,
  DashboardCircleIcon,
  ArrowLeft01Icon,
  Add01Icon,
  CheckmarkCircle02Icon,
  AlertCircleIcon,
  PackageOpenIcon,
} from "@/components/icons";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { ChatInputBar } from "@/components/ai-elements/chat-input-bar";
import { ChatMessage } from "@/components/chat/chat-message";
import { useAssistant } from "@/components/assistant/assistant-context";
import { AssistantChatError } from "@/components/assistant/chat-error";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { blueprintAtom } from "@/atoms/artifact";
import { hideShellHeaderAtom } from "@/atoms/shell";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CORE_URL } from "@/lib/constants";
import type { BlueprintState } from "@/components/creator/blueprint-draft-bar";
import { BlueprintDraftBar } from "@/components/creator/blueprint-draft-bar";
import { ClaudeTerminal } from "@/components/terminal/claude-terminal";
import { Switch } from "@/components/ui/switch";
import { useConfirmAction } from "@/hooks/use-confirm-action";
import useSWR from "swr";

interface SuggestionItem {
  label: string;
  prompt: string;
}

const FALLBACK_SUGGESTIONS: SuggestionItem[] = [
  { label: "Check system health", prompt: "How's my server doing?" },
  { label: "What's downloading?", prompt: "What's currently downloading?" },
  { label: "Suggest a movie tonight", prompt: "Suggest something to watch tonight" },
  { label: "Find available updates", prompt: "Are there any updates available?" },
  { label: "Set up an automation", prompt: "I want to automate something" },
  { label: "Create a custom app", prompt: "I want to create a new app" },
  { label: "What's coming this week?", prompt: "What's coming out this week?" },
  { label: "Set up notifications", prompt: "I want to get notified about things" },
];

const suggestionsFetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return null;
  return res.json();
};

/** Fetch personalized suggestions (1-day cooldown server-side).
 *  Shows hardcoded fallbacks immediately, swaps to personalized once loaded. */
function useSuggestions(): SuggestionItem[] {
  const { data } = useSWR<{ suggestions: SuggestionItem[] } | null>(
    `${CORE_URL}/api/suggestions`,
    suggestionsFetcher,
    { revalidateOnFocus: false, revalidateIfStale: false, dedupingInterval: 5 * 60_000 },
  );
  return data?.suggestions ?? FALLBACK_SUGGESTIONS;
}

const MAX_VISIBLE_HISTORY_PER_GROUP = 3;

function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  if (date >= weekAgo) return "This week";
  return "Older";
}

function ThinkingMessage() {
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex items-center gap-1.5 py-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-foreground/40"
              style={{
                animation: "thinking-dot 1.4s ease-in-out infinite",
                animationDelay: `${i * 150}ms`,
              }}
            />
          ))}
        </div>
      </MessageContent>
    </Message>
  );
}

/** Extract blueprint section update from a design_app_blueprint tool input. */
function applyBlueprintUpdate(prev: BlueprintState, input: Record<string, unknown>): BlueprintState {
  const next = { ...prev };
  const section = input.section as string;

  switch (section) {
    case "identity":
      next.identity = {
        id: input.id as string | undefined,
        name: input.name as string | undefined,
        description: input.description as string | undefined,
        category: input.category as string | undefined,
        icon: input.icon as string | undefined,
      };
      break;
    case "services":
      next.services = input.services as BlueprintState["services"];
      break;
    case "env":
      next.env = input.env as BlueprintState["env"];
      break;
    case "scaffold":
      next.scaffold = {
        enabled: input.enabled as boolean,
        kind: input.kind as string,
        framework: input.framework as string | undefined,
      };
      break;
    case "criteria":
      next.criteria = input.criteria as string[];
      break;
  }

  return next;
}

// Store navigation origin so the back button can return to it
const originRef = { current: null as string | null };

/** Inline header for the assistant page (replaces the shell header). */
function AssistantHeader({
  showingChat,
  onBack,
  onNew,
}: {
  showingChat: boolean;
  onBack: () => void;
  onNew: () => void;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const { conversations, activeId, autoMode, setAutoMode } = useAssistant();

  const title = activeId ? conversations.find((c) => c.id === activeId)?.title : undefined;

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 bg-background/75 px-4 backdrop-blur-sm">
      {/* Desktop: sidebar toggle */}
      <div className="hidden md:flex">
        <SidebarTrigger className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors">
          <HugeiconsIcon icon={LayoutAlignLeftIcon} size={20} strokeWidth={1.5} />
        </SidebarTrigger>
      </div>

      {/* Mobile: nav trigger */}
      <div className="flex md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
        >
          <HugeiconsIcon icon={DashboardCircleIcon} size={18} strokeWidth={1.5} />
        </Button>
        <MobileNav open={mobileNavOpen} onClose={closeMobileNav} />
      </div>

      {/* Back button */}
      {showingChat && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground transition-colors -ml-1"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
        </Button>
      )}

      <span className={`text-sm font-medium truncate ${showingChat && title ? "text-muted-foreground" : ""}`}>
        {showingChat && title ? title : "Assistant"}
      </span>

      <div className="ml-auto shrink-0 flex items-center gap-2">
        {/* Auto mode toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <span className={`text-xs font-medium ${autoMode ? "text-status-warning" : "text-muted-foreground"}`}>
                Auto
              </span>
              <Switch
                size="sm"
                checked={autoMode}
                onCheckedChange={setAutoMode}
                aria-label="Auto mode"
              />
            </label>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {autoMode ? "Skip permission prompts" : "Require permission prompts"}
          </TooltipContent>
        </Tooltip>

        {showingChat && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={onNew}
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
            New
          </Button>
        )}
      </div>
    </header>
  );
}

/** Inline result card shown after build completes. */
function BuildResultCard({
  result,
  onDismiss,
}: {
  result: {
    ok: boolean;
    appId: string;
    fileCount: number;
    hasCompose: boolean;
    hasManifest: boolean;
    error?: string;
    republishError?: string;
    duration: number;
  };
  onDismiss: () => void;
}) {
  const ok = result.ok;
  const durationLabel = result.duration < 1000
    ? `${result.duration}ms`
    : result.duration < 60_000
      ? `${(result.duration / 1000).toFixed(1)}s`
      : `${Math.round(result.duration / 60_000)}m`;

  return (
    <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-3">
      <div className="rounded-xl border border-border/40 bg-card/30 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <HugeiconsIcon
            icon={ok ? CheckmarkCircle02Icon : AlertCircleIcon}
            size={18}
            className={ok ? "text-status-healthy" : "text-destructive"}
          />
          <div>
            <p className="text-sm font-medium">
              {ok ? "App built successfully" : "Build completed with issues"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {result.fileCount} file{result.fileCount !== 1 ? "s" : ""} generated
              {" · "}{durationLabel}
              {!result.hasCompose && " · missing docker-compose.yml"}
            </p>
          </div>
        </div>

        {(result.error || result.republishError) && (
          <p className="text-xs text-destructive/70 bg-destructive/5 rounded-lg px-3 py-2">
            {result.error || result.republishError}
          </p>
        )}

        <button
          onClick={onDismiss}
          className="flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          <HugeiconsIcon icon={ok ? PackageOpenIcon : ArrowLeft01Icon} size={14} />
          {ok ? "View App" : "Back to Chat"}
        </button>
      </div>
    </div>
  );
}

export default function AssistantPage() {
  const pathname = usePathname();
  const router = useRouter();
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const {
    messages, status, error, clearError, stop,
    conversations, activeId, setActiveId, deleteConversation,
    handleSubmit, addToolApprovalResponse, regenerate,
    model, setModel, modelOptions, startNew, autoMode, isSubmitting,
  } = useAssistant();
  const keyboard = useKeyboardMode();
  const { confirmAction, ConfirmDialog } = useConfirmAction(autoMode);
  const suggestions = useSuggestions();

  const [blueprint, setBlueprint] = useAtom(blueprintAtom);
  const setHideShellHeader = useSetAtom(hideShellHeaderAtom);
  const [building, setBuilding] = useState(false);
  const [autoExec, setAutoExec] = useState(false);

  // Sync auto mode from localStorage after hydration to avoid SSR mismatch
  useEffect(() => {
    setAutoExec(localStorage.getItem("talome-auto-mode") === "true");
  }, []);
  const [buildSession, setBuildSession] = useState<{
    sessionName: string;
    command: string;
    taskPrompt: string;
    appId: string;
    workspaceRoot: string;
  } | null>(null);
  const [buildResult, setBuildResult] = useState<{
    ok: boolean;
    appId: string;
    fileCount: number;
    hasCompose: boolean;
    hasManifest: boolean;
    error?: string;
    republishError?: string;
    duration: number;
  } | null>(null);

  const isActive = status === "streaming" || status === "submitted";
  const hasBlueprint = !!blueprint.identity?.name;

  // `dismissed` hides the chat view without stopping the stream.
  // The stream keeps running in the background; clicking a conversation
  // or submitting a message clears the flag and shows the chat again.
  const [dismissed, setDismissed] = useState(false);
  const showingChat = !dismissed && (messages.length > 0 || activeId !== null);

  const handleBack = useCallback(() => {
    if (originRef.current) {
      const dest = originRef.current;
      originRef.current = null;
      router.push(dest);
    } else {
      setDismissed(true);
    }
    // Clear conversation-specific UI state on back navigation.
    // The cleanup effect on activeId doesn't fire when only dismissed changes.
    setBlueprint({});
    setBuildSession(null);
    setBuildResult(null);
  }, [router, setBlueprint]);

  const handleNew = useCallback(async () => {
    // If streaming, confirm before discarding the active conversation
    if (status === "streaming" || status === "submitted") {
      const ok = await confirmAction({
        title: "Start new conversation?",
        description: "The current response will be stopped. Your conversation history is saved.",
        confirmLabel: "New conversation",
        variant: "default",
      });
      if (!ok) return;
    }
    startNew();
    setDismissed(false);
  }, [startNew, status, confirmAction]);

  // Hide the shell header — this page renders its own
  useEffect(() => {
    setHideShellHeader(true);
    return () => setHideShellHeader(false);
  }, [setHideShellHeader]);

  // Auto-submit ?prompt=, store ?from= origin, and restore ?c= conversation
  const promptSubmittedRef = useRef(false);
  useEffect(() => {
    if (promptSubmittedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get("prompt");
    const from = params.get("from");
    const conversationId = params.get("c");

    // Store origin before stripping — validate it's a dashboard path
    if (from && from.startsWith("/dashboard/")) {
      originRef.current = from;
    }

    // Restore active conversation from URL (only if provider state is empty)
    if (conversationId && !activeId) {
      setActiveId(conversationId);
    }

    if (!prompt && !from) return;
    if (prompt && messages.length > 0) return;

    if (prompt) promptSubmittedRef.current = true;

    // Strip prompt and from params — keep ?c= for state preservation
    params.delete("prompt");
    params.delete("from");
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });

    if (prompt) handleSubmit(prompt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync activeId to URL for state preservation across page navigations
  const prevActiveIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    if (prevActiveIdRef.current === activeId) return;
    prevActiveIdRef.current = activeId;

    const params = new URLSearchParams(window.location.search);
    const currentC = params.get("c");

    // Skip if URL already matches
    if ((activeId && currentC === activeId) || (!activeId && !currentC)) return;

    if (activeId) {
      params.set("c", activeId);
    } else {
      params.delete("c");
    }
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [activeId, pathname, router]);

  // Clear blueprint and build session when switching conversations.
  // The draft bar is only for the current design session — past conversations
  // show inline markers instead. This avoids showing stale "Build" buttons
  // for apps that were already created.
  useEffect(() => {
    setBlueprint({});
    setBuildSession(null);
    setBuildResult(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Accumulate blueprint updates from streaming tool calls
  const handleBlueprintUpdate = useCallback(
    (input: Record<string, unknown>) => {
      if (input.section) {
        setBlueprint((prev) => applyBlueprintUpdate(prev, input));
      }
    },
    [setBlueprint],
  );

  // Build flow: create draft → show inline Claude Code terminal
  const handleBlueprintBuild = useCallback(async () => {
    if (!blueprint.identity?.name || !blueprint.services?.length || !blueprint.criteria?.length) return;
    if (building) return;

    setBuilding(true);

    try {
      const description = blueprint.identity.description || blueprint.identity.name;

      const res = await fetch(`${CORE_URL}/api/apps/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          mode: "both",
          saveImmediately: true,
          source: { kind: "auto" },
          preBuiltBlueprint: blueprint,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create app");
      }

      if (data.draft?.workspace?.rootPath) {
        const taskPrompt = data.draft.taskPrompt
          ?? `You are helping the user create "${blueprint.identity.name}". Read the blueprint and instructions in .talome-creator/ first.`;

        const execRes = await fetch(`${CORE_URL}/api/apps/create/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceRoot: data.draft.workspace.rootPath,
            taskPrompt,
            appId: data.draft.app.id,
            auto: autoExec,
          }),
        });

        if (execRes.ok) {
          const execData = await execRes.json() as {
            sessionName: string;
            command: string;
            taskPrompt: string;
            workspaceRoot: string;
          };
          setBuildSession({
            sessionName: execData.sessionName,
            command: execData.command,
            taskPrompt: execData.taskPrompt,
            appId: data.draft.app.id,
            workspaceRoot: execData.workspaceRoot,
          });
        }
      } else {
        router.push(`/dashboard/apps/${data.storeId}/${data.appId}`);
        setBlueprint({});
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Build failed";
      handleSubmit(`Build failed: ${msg}. Can you help fix this?`);
    } finally {
      setBuilding(false);
    }
  }, [blueprint, building, router, setBlueprint, handleSubmit]);

  const [completing, setCompleting] = useState(false);

  const handleBuildComplete = useCallback(async () => {
    if (!buildSession) return { ok: true as const };
    setCompleting(true);

    try {
      const res = await fetch(`${CORE_URL}/api/apps/create/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: buildSession.appId,
          workspaceRoot: buildSession.workspaceRoot,
        }),
      });
      const result = await res.json();
      setBuildResult(result);
      return { ok: true as const };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verification failed";
      setBuildResult({
        ok: false,
        appId: buildSession.appId,
        fileCount: 0,
        hasCompose: false,
        hasManifest: false,
        error: msg,
        duration: 0,
      });
      return { ok: false as const, typeErrors: msg };
    } finally {
      setBuildSession(null);
      setCompleting(false);
    }
  }, [buildSession]);

  const handleBuildCancel = useCallback(() => {
    setBuildSession(null);
  }, []);

  const handleBuildResultDismiss = useCallback(() => {
    const appId = buildResult?.appId;
    setBuildResult(null);
    setBlueprint({});
    if (appId && buildResult?.ok) {
      router.push(`/dashboard/apps/user-apps/${appId}`);
    }
  }, [buildResult, setBlueprint, router]);

  const handleDismissBlueprint = useCallback(() => {
    setBlueprint({});
  }, [setBlueprint]);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof conversations[number][]> = {};
    for (const conv of conversations) {
      const group = getDateGroup(conv.updatedAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(conv);
    }
    return groups;
  }, [conversations]);

  const onSubmit = useCallback(
    ({ text, files }: { text: string; files: FileUIPart[] }) => {
      setDismissed(false);
      handleSubmit(text, `Current page: ${pathname}`, files);
    },
    [handleSubmit, pathname]
  );

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      setDismissed(false);
      handleSubmit(suggestion);
    },
    [handleSubmit]
  );

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  }, []);

  // ── Chat content ──────────────────────────────────────────────────────────

  const chatContent = showingChat ? (
    <Conversation className="flex-1 min-h-0" initial="smooth" resize="smooth">
      <ConversationContent className="max-w-2xl mx-auto w-full py-4 sm:py-6 px-4 sm:px-6">
        {messages.map((message, index) => (
          <ChatMessage
            key={`${message.id}-${index}`}
            message={message}
            addToolApprovalResponse={addToolApprovalResponse}
            onRegenerate={regenerate}
            onBlueprintUpdate={handleBlueprintUpdate}
            isLast={index === messages.length - 1}
            isStreaming={isActive && index === messages.length - 1}
          />
        ))}
        {isActive && messages[messages.length - 1]?.role === "user" && (
          <ThinkingMessage />
        )}
        {error && <AssistantChatError error={error} onDismiss={clearError} />}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  ) : (
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-none">
      <div className="max-w-2xl mx-auto w-full py-4 sm:py-6 px-4 sm:px-6">
        <div className="flex size-full flex-col items-center justify-center px-2 sm:px-4">
          {error ? (
            <div className="w-full max-w-md mb-6">
              <AssistantChatError error={error} onDismiss={clearError} />
            </div>
          ) : null}
          <h2 className="text-xl sm:text-2xl font-medium tracking-tight text-foreground mb-6 sm:mb-8">
            How can I help?
          </h2>

          <div className="grid grid-cols-2 gap-2 w-full max-w-sm mb-8 sm:mb-10">
            {suggestions.map((s, i) => (
              <button
                key={`${i}-${s.label}`}
                onClick={() => handleSuggestion(s.prompt)}
                className="rounded-2xl px-3 sm:px-4 py-3 text-sm text-left text-muted-foreground bg-foreground/[0.04] active:bg-foreground/[0.08] transition-all duration-150 hover:bg-foreground/[0.07] hover:text-foreground"
              >
                {s.label}
              </button>
            ))}
          </div>

          {conversations.length > 0 && (
            <div className="w-full max-w-sm">
              {Object.entries(grouped).map(([group, convs]) => {
                const isExpanded = !!expandedGroups[group];
                const visibleConvs = isExpanded ? convs : convs.slice(0, MAX_VISIBLE_HISTORY_PER_GROUP);
                const hiddenCount = Math.max(0, convs.length - visibleConvs.length);

                return (
                  <div key={group} className="pb-1.5">
                    <div className="px-1 pb-1.5 pt-3 first:pt-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {group}
                    </div>
                    {visibleConvs.map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => { setActiveId(conv.id); setDismissed(false); }}
                        className="flex items-center w-full rounded-lg px-3 py-3 sm:py-2.5 text-left text-sm text-muted-foreground transition-colors duration-100 group/item active:bg-accent/40 hover:text-foreground hover:bg-accent/30"
                      >
                        <span className="flex-1 truncate">{conv.title}</span>
                        {conv.platform === "telegram" && (
                          <span title="Telegram" className="shrink-0 mr-1.5 opacity-40 text-xs font-medium tracking-wide">TG</span>
                        )}
                        {conv.platform === "discord" && (
                          <span title="Discord" className="shrink-0 mr-1.5 opacity-40 text-xs font-medium tracking-wide">DC</span>
                        )}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={async (e) => {
                            e.stopPropagation();
                            const ok = await confirmAction({
                              title: "Delete conversation?",
                              description: "This conversation and all its messages will be permanently deleted.",
                              confirmLabel: "Delete",
                              variant: "destructive",
                            });
                            if (ok) deleteConversation(conv.id);
                          }}
                          onKeyDown={async (e) => {
                            if (e.key === "Enter") {
                              e.stopPropagation();
                              const ok = await confirmAction({
                                title: "Delete conversation?",
                                description: "This conversation and all its messages will be permanently deleted.",
                                confirmLabel: "Delete",
                                variant: "destructive",
                              });
                              if (ok) deleteConversation(conv.id);
                            }
                          }}
                          className="opacity-40 sm:opacity-0 sm:group-hover/item:opacity-40 hover:!opacity-100 shrink-0 text-muted-foreground hover:text-destructive transition-opacity duration-100 ml-2"
                        >
                          <HugeiconsIcon icon={Delete01Icon} size={12} />
                        </span>
                      </button>
                    ))}
                    {convs.length > MAX_VISIBLE_HISTORY_PER_GROUP && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className="mt-1 mb-2 w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground"
                      >
                        {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const inputBar = (
    <ChatInputBar
      status={status as ChatStatus}
      onSubmit={onSubmit}
      onStop={stop}
      placeholder="Ask Talome anything..."
      extraTools={
        <>
          {modelOptions.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    const idx = modelOptions.findIndex((o) => o.id === model);
                    const next = modelOptions[(idx + 1) % modelOptions.length];
                    if (next) setModel(next.id);
                  }}
                  className={`inline-flex items-center justify-center h-8 rounded-md px-2 text-xs font-medium transition-colors duration-150 hover:bg-accent ${
                    modelOptions.findIndex((o) => o.id === model) > 0
                      ? "text-foreground"
                      : "text-dim-foreground"
                  }`}
                >
                  {modelOptions.find((o) => o.id === model)?.name ?? model.split("/").pop()?.split("-")[0] ?? "Model"}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {(() => {
                  const idx = modelOptions.findIndex((o) => o.id === model);
                  const next = modelOptions[(idx + 1) % modelOptions.length];
                  return `Switch to ${next?.name ?? "next model"}`;
                })()}
              </TooltipContent>
            </Tooltip>
          )}
          {keyboard.showToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={keyboard.toggle}
                  className={`inline-flex items-center justify-center size-8 rounded-md transition-colors hover:bg-accent ${keyboard.mode === "virtual" ? "text-foreground" : "text-dim-foreground"}`}
                >
                  <HugeiconsIcon icon={KeyboardIcon} size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {keyboard.mode === "virtual" ? "Virtual keyboard on" : "Virtual keyboard off"}
              </TooltipContent>
            </Tooltip>
          )}
        </>
      }
    />
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden overscroll-none">
      <ConfirmDialog />
      <AssistantHeader showingChat={showingChat} onBack={handleBack} onNew={handleNew} />
      {chatContent}
      {/* Inline Claude Code terminal — replaces chat when building */}
      {buildSession && (
        <div className="flex-shrink-0 border-t border-border/40" style={{ height: "min(24rem, 50vh)" }}>
          <ClaudeTerminal
            sessionName={buildSession.sessionName}
            command={buildSession.command}
            taskPrompt={buildSession.taskPrompt}
            completeLabel="Complete & Verify"
            onComplete={handleBuildComplete}
            onCancel={handleBuildCancel}
            completing={completing}
          />
        </div>
      )}
      {/* Build result card */}
      {buildResult && !buildSession && (
        <BuildResultCard result={buildResult} onDismiss={handleBuildResultDismiss} />
      )}
      {/* Bottom section: fade + blueprint bar + input */}
      {!buildSession && !buildResult && (
        <div className="relative shrink-0">
          <div className="pointer-events-none absolute inset-x-0 -top-12 h-12 bg-gradient-to-t from-background to-transparent" />
          {hasBlueprint && showingChat && (
            <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 pb-2 pt-1">
              <BlueprintDraftBar
                blueprint={blueprint}
                onBuild={handleBlueprintBuild}
                building={building}
                onDismiss={handleDismissBlueprint}
                auto={autoExec}
                onAutoChange={(v) => {
                  setAutoExec(v);
                  localStorage.setItem("talome-auto-mode", String(v));
                }}
              />
            </div>
          )}
          {inputBar}
        </div>
      )}
    </div>
  );
}
