"use client";

import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ChatStatus, FileUIPart } from "ai";
import { useAtom, useSetAtom } from "jotai";
import {
  HugeiconsIcon,
  Delete01Icon,
  LayoutAlignLeftIcon,
  DashboardCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
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
import { VoiceMode } from "@/components/assistant/voice-mode";
import { ThinkingIndicator } from "@/components/assistant/thinking-indicator";
import { ThinkingOrb } from "thinking-orbs";
import {
  SourceList,
  SourceListItem,
  SourceListSection,
  WINDOW_SIDEBAR_REPLACES,
  WindowSidebarLayout,
} from "@/components/ui/source-list";
import { pendingActivity, pendingApprovalRequest } from "@/lib/agent-activity";
import { humanToolName } from "@/components/trust/format";
import { ChatMessage } from "@/components/chat/chat-message";
import { useAssistant } from "@/components/assistant/assistant-context";
import { AssistantModelSelector } from "@/components/assistant/assistant-model-selector";
import { AssistantChatError } from "@/components/assistant/chat-error";
import { ChatSourceItem, chatTitle } from "@/components/assistant/chat-source-item";
import { focusHomeAfterNewChat, restoreFocusAfterChatLeft, type ChatList } from "@/components/assistant/chat-list-focus";
import { AssistantToolbar, ComposerKeyboardToggle, NewChatButton } from "@/components/assistant/assistant-toolbar";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useBlueprintBuild } from "@/hooks/use-blueprint-build";
import { blueprintAtom } from "@/atoms/artifact";
import { pageBackAtom } from "@/atoms/page-back";
import { pageTitleAtom } from "@/atoms/page-title";
import { hideShellHeaderAtom } from "@/atoms/shell";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { BlueprintState } from "@/components/creator/blueprint-draft-bar";
import { BlueprintDraftBar } from "@/components/creator/blueprint-draft-bar";
import { ClaudeTerminal } from "@/components/terminal/claude-terminal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useUndoableDelete } from "@/components/chat/use-undoable-delete";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import useSWR from "swr";
import { safeRedirectPath } from "@/lib/safe-redirect";

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

function ThinkingMessage({ label }: { label: string }) {
  return (
    <Message from="assistant">
      <MessageContent>
        <ThinkingIndicator label={label} />
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
    case "research":
      next.research = input.research as BlueprintState["research"];
      break;
    case "design":
      next.experienceDesign = input.experienceDesign as BlueprintState["experienceDesign"];
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
    case "experience":
      next.appSpec = input.appSpec as BlueprintState["appSpec"];
      break;
  }

  return next;
}

// Store navigation origin so the back button can return to it
const originRef = { current: null as string | null };

/** Inline header for the assistant page (replaces the shell header). */
function AssistantHeader({
  showingChat,
  backToOrigin,
  onBack,
  onNew,
}: {
  showingChat: boolean;
  /** Back returns to the page that opened the Assistant, not to the chat list */
  backToOrigin: boolean;
  onBack: () => void;
  onNew: () => void;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const { conversations, activeId } = useAssistant();

  const title = activeId ? conversations.find((c) => c.id === activeId)?.title : undefined;

  return (
    // Nothing scrolls under this header (the conversation is its own scroller),
    // so it needs no backdrop: it sits on the page like the rest of the view.
    <header className="flex h-12 shrink-0 items-center gap-1.5 px-4">
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
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground transition-colors phone-touch:size-11"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
        >
          <HugeiconsIcon icon={DashboardCircleIcon} size={18} strokeWidth={1.5} />
        </Button>
        <MobileNav open={mobileNavOpen} onClose={closeMobileNav} />
      </div>

      {/* Back to the chat list, leaving a reply that is being written running
          (New chat stops it), or to the page that opened the Assistant */}
      {showingChat && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground transition-colors -ml-1 phone-touch:size-11"
          onClick={onBack}
          aria-label={backToOrigin ? "Back" : "Back to conversations"}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
        </Button>
      )}

      <span className={`text-sm font-medium truncate ${showingChat && title ? "text-muted-foreground" : ""}`}>
        {showingChat && title ? title : "Assistant"}
      </span>

      {/* The verb at the trailing end, as in a window's toolbar row */}
      <div className="ml-auto shrink-0 flex items-center gap-2">
        {showingChat && <NewChatButton onSelect={onNew} />}
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
    <div className="mx-auto w-full max-w-2xl px-4 py-3 @md/assistant:px-6">
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
          <p className="rounded-lg bg-status-critical/12 px-3 py-2 text-xs text-foreground wrap-anywhere">
            {result.error || result.republishError}
          </p>
        )}

        <Button type="button" size="sm" onClick={onDismiss}>
          <HugeiconsIcon icon={ok ? PackageOpenIcon : ArrowLeft01Icon} size={14} aria-hidden="true" />
          {ok ? "View app" : "Back to chat"}
        </Button>
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
    handleSubmit, regenerate,
    model, setModel, modelOptions, activeProvider, modelReady, startNew, isSubmitting,
  } = useAssistant();
  const embeddedFrame = useIsEmbeddedFrame();
  const keyboard = useKeyboardMode();
  const confirm = useConfirm();
  const suggestions = useSuggestions();

  const [blueprint, setBlueprint] = useAtom(blueprintAtom);
  const setPageBack = useSetAtom(pageBackAtom);
  const setPageTitle = useSetAtom(pageTitleAtom);
  const setHideShellHeader = useSetAtom(hideShellHeaderAtom);
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
  // A tool held for approval shows its approval card, not "Thinking" (pendingActivity).
  const pendingLabel = pendingActivity(messages, status);
  const hasBlueprint = !!blueprint.identity?.name;

  // `dismissed` hides the chat view without stopping the stream.
  // The stream keeps running in the background; clicking a conversation
  // or submitting a message clears the flag and shows the chat again.
  const [dismissed, setDismissed] = useState(false);
  const showingChat = !dismissed && (messages.length > 0 || activeId !== null);

  // Delete is undoable: the chat leaves the list at once and is deleted on
  // the server after the Undo window. Deleting the open chat (or the one a
  // Back left running behind the home view) also leaves it at once, as New
  // chat does: its response stops, and nothing you send in the meantime can
  // go to a chat that is about to disappear. Undo reopens it, as saved,
  // unless you have opened or started another chat since.
  const leftChatRef = useRef<string | null>(null);
  const removeConversation = useCallback(
    (id: string, options?: { keepalive?: boolean }) => {
      // Past Undo: forget it, so the effect below never reopens it
      if (leftChatRef.current === id) leftChatRef.current = null;
      return deleteConversation(id, options);
    },
    [deleteConversation],
  );
  const { pending: pendingDeletes, request: requestUndoableDelete } = useUndoableDelete(removeConversation);
  // Every chat in the order both lists show them: date groups, newest first
  const grouped = useMemo(() => {
    const groups: Record<string, typeof conversations[number][]> = {};
    for (const conv of conversations) {
      const group = getDateGroup(conv.updatedAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(conv);
    }
    return groups;
  }, [conversations]);
  const chatOrder = useMemo(() => Object.values(grouped).flat().map((conv) => conv.id), [grouped]);
  // The deleted row takes focus with it: once it has left the page, focus
  // moves to the next chat in the same list (see chat-list-focus.ts)
  const leftListRef = useRef<{ id: string; list: ChatList; order: readonly string[] } | null>(null);
  const requestDelete = useCallback(
    (id: string, label: string, list: ChatList) => {
      if (pendingDeletes.has(id)) return;
      leftListRef.current = { id, list, order: chatOrder };
      if (id === activeId) {
        leftChatRef.current = id;
        startNew();
        setDismissed(false);
      }
      requestUndoableDelete(id, label);
    },
    [activeId, chatOrder, pendingDeletes, requestUndoableDelete, startNew],
  );
  useEffect(() => {
    const left = leftListRef.current;
    if (!left || !pendingDeletes.has(left.id)) return;
    leftListRef.current = null;
    restoreFocusAfterChatLeft(left);
  }, [pendingDeletes]);
  useEffect(() => {
    const id = leftChatRef.current;
    if (!id) return;
    // Another chat is open (or a new one was saved): Undo only puts it back in the list
    if (activeId !== null) {
      leftChatRef.current = null;
      return;
    }
    if (pendingDeletes.has(id)) return;
    // It left the Undo window without being deleted (a delete forgets it
    // first), so Undo was chosen: reopen it, unless a new chat is under way
    leftChatRef.current = null;
    if (messages.length > 0 || isSubmitting) return;
    setActiveId(id);
    setDismissed(false);
  }, [activeId, isSubmitting, messages.length, pendingDeletes, setActiveId]);

  const activeConversationTitle = activeId
    ? conversations.find((conversation) => conversation.id === activeId)?.title
    : undefined;

  // The page that opened the Assistant (?from=), mirrored from originRef so
  // the chrome can follow it. Back returns there; in a window, the desktop
  // itself is no destination (Back would only show the home view, which is
  // New chat's job), so a window's Back shows only for another page.
  const [origin, setOrigin] = useState<string | null>(() => originRef.current);
  const windowBackLeaves = origin !== null && origin !== "/dashboard/desktop";

  const handleBack = useCallback(() => {
    if (originRef.current) {
      const dest = originRef.current;
      originRef.current = null;
      setOrigin(null);
      if (embeddedFrame && dest === "/dashboard/desktop") {
        setDismissed(true);
      } else if (!requestDesktopNavigation(dest)) {
        router.push(dest);
      }
    } else {
      setDismissed(true);
    }
    // Clear conversation-specific UI state on back navigation.
    // The cleanup effect on activeId doesn't fire when only dismissed changes.
    setBlueprint({});
    setBuildSession(null);
    setBuildResult(null);
  }, [embeddedFrame, router, setBlueprint]);

  /** Starts a new chat; false when you chose to keep the reply being written */
  const handleNew = useCallback(async () => {
    // If streaming, confirm before discarding the active conversation
    if (status === "streaming" || status === "submitted") {
      const { confirmed } = await confirm({
        tier: "soft",
        title: "Start a new conversation?",
        consequence: "The Assistant stops the response it's writing now.",
        recovery: "This conversation is saved, so you can open it again from the list.",
        confirmLabel: "Start new conversation",
      });
      if (!confirmed) return false;
    }
    startNew();
    setDismissed(false);
    return true;
  }, [startNew, status, confirm]);

  // New chat in the classic header or a window's toolbar row belongs to the
  // chat view, so it leaves the page with the chat: focus moves on to the
  // home view (see focusHomeAfterNewChat) once the chat has gone. The
  // sidebar's row stays, and keeps focus.
  const focusHomeRef = useRef(false);
  const handleNewFromChat = useCallback(async () => {
    focusHomeRef.current = true;
    if (!(await handleNew())) focusHomeRef.current = false;
  }, [handleNew]);
  useEffect(() => {
    if (showingChat || !focusHomeRef.current) return;
    focusHomeRef.current = false;
    focusHomeAfterNewChat();
  }, [showingChat]);

  // A window's title bar holds the window controls, the title (the open
  // chat) and a leading Back only where Back goes somewhere New chat doesn't:
  // the page that opened the Assistant. Going home is New chat, in the
  // sidebar or (narrow window) the toolbar row, so the title bar publishes
  // no verbs.
  useEffect(() => {
    if (!embeddedFrame) return;

    setPageTitle(showingChat && activeConversationTitle
      ? activeConversationTitle
      : "Assistant");
    setPageBack(showingChat && windowBackLeaves ? () => handleBack : null);

    return () => {
      setPageBack(null);
      setPageTitle(null);
    };
  }, [
    activeConversationTitle,
    embeddedFrame,
    handleBack,
    setPageBack,
    setPageTitle,
    showingChat,
    windowBackLeaves,
  ]);

  // Hide the shell header — this page renders its own
  useEffect(() => {
    setHideShellHeader(true);
    return () => setHideShellHeader(false);
  }, [setHideShellHeader]);

  // Auto-submit ?prompt=, store ?from= origin, and restore ?c= conversation
  const promptSubmittedRef = useRef(false);
  const incomingPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (promptSubmittedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    incomingPromptRef.current ??= params.get("prompt");
    const prompt = incomingPromptRef.current;
    const from = params.get("from");
    const conversationId = params.get("c");

    // Store origin before stripping — validate it's a dashboard path
    const safeOrigin = from ? safeRedirectPath(from, "", { within: "/dashboard" }) : "";
    if (safeOrigin) {
      originRef.current = safeOrigin;
      setOrigin(safeOrigin);
    }

    // Restore active conversation from URL (only if provider state is empty)
    if (conversationId && !activeId) {
      setActiveId(conversationId);
    }

    if (!prompt && !from) return;
    if (prompt && !modelReady) return;
    // A widget question starts its own saved conversation, even when the
    // classic shell already has an active quick exchange.
    if (prompt && (messages.length > 0 || activeId)) {
      startNew();
      return;
    }

    if (prompt) promptSubmittedRef.current = true;

    // Strip prompt and from params — keep ?c= for state preservation
    params.delete("prompt");
    params.delete("from");
    const qs = params.toString();
    const cleanUrl = `${pathname}${qs ? `?${qs}` : ""}`;
    // Remove one-shot parameters before sending. Next navigation is async and
    // a newly-created conversation may otherwise race it and preserve prompt.
    window.history.replaceState(window.history.state, "", cleanUrl);
    router.replace(cleanUrl, { scroll: false });

    if (prompt) handleSubmit(prompt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelReady, messages.length, activeId]);

  // A conversation state update can complete after Next's URL replacement and
  // restore the previous search string. Re-assert removal after the first
  // message/active conversation is committed so refresh can never replay it.
  useEffect(() => {
    if (!activeId && messages.length === 0) return;
    if (incomingPromptRef.current && !promptSubmittedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("prompt") && !params.has("from")) return;
    params.delete("prompt");
    params.delete("from");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${pathname}${qs ? `?${qs}` : ""}`,
    );
  }, [activeId, messages.length, pathname]);

  // Sync activeId to URL for state preservation across page navigations
  const prevActiveIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    if (prevActiveIdRef.current === activeId) return;
    prevActiveIdRef.current = activeId;

    const params = new URLSearchParams(window.location.search);
    // A conversation can be created before the earlier router.replace commits.
    // Never let the active-id sync reintroduce one-shot handoff parameters.
    params.delete("prompt");
    params.delete("from");
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

  const { build: startBlueprintBuild, building, error: buildError } = useBlueprintBuild(blueprint, setBuildSession, activeId);
  const handleBlueprintBuild = useCallback(async () => {
    if (
      !blueprint.identity?.name ||
      !blueprint.research?.useCases.length ||
      !blueprint.research.githubQueries.length ||
      !blueprint.experienceDesign?.workflows.length ||
      !blueprint.experienceDesign.screens.length ||
      !blueprint.services?.length ||
      !blueprint.appSpec?.surfaces.length ||
      !blueprint.criteria?.length
    ) return;
    await startBlueprintBuild();
  }, [blueprint, startBlueprintBuild]);

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
      return result.ok && res.ok ? { ok: true as const } : { ok: false as const };
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
      return { ok: false as const };
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
    if (appId && buildResult?.ok) {
      setBlueprint({});
      const href = `/dashboard/apps/user-apps/${appId}`;
      if (!requestDesktopNavigation(href)) router.push(href);
    }
  }, [buildResult, setBlueprint, router]);

  const handleDismissBlueprint = useCallback(() => {
    setBlueprint({});
  }, [setBlueprint]);

  // Voice conversation: speaks the latest assistant reply when it finishes
  const [voiceOpen, setVoiceOpen] = useState(false);
  const lastAssistant = useMemo(() => {
    const message = [...messages].reverse().find((m) => m.role === "assistant");
    if (!message) return null;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    // A tool held for a server-issued approval (`approval_required`): the voice
    // asks you to approve it on screen (the approval card), never by voice.
    const waiting = pendingApprovalRequest(message);
    const pendingApproval = waiting ? humanToolName(waiting.tool) : undefined;
    return { id: message.id, text, pendingApproval };
  }, [messages]);
  const voiceHistory = useCallback(
    () =>
      messages
        .map((m) => ({
          role: m.role,
          content: m.parts.map((part) => (part.type === "text" ? part.text : "")).join("").trim().slice(0, 2000),
        }))
        .filter((m): m is { role: "user" | "assistant"; content: string } => (m.role === "user" || m.role === "assistant") && m.content.length > 0),
    [messages],
  );
  const sendVoiceMessage = useCallback((text: string) => {
    setDismissed(false);
    handleSubmit(text, `Current page: ${pathname}. The user is speaking in voice mode — answer briefly and conversationally, without tables or code unless asked.`);
  }, [handleSubmit, pathname]);

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

  // The scroller fades into the input bar below it. A mask, not a gradient in
  // the background colour, so it reads the same on window glass. At rest the
  // fade is exactly the content's bottom padding (pb-6), so the last line is
  // never faded or covered. Scrolled up, the bottom 2.25rem clears for the
  // scroll-to-bottom button (ConversationScrollButton marks itself), so the
  // button never sits over text you can read.
  const showInputBar = !buildSession && !buildResult;
  const bottomFade = showInputBar
    ? cn(
        "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]",
        "group-has-[[data-conversation-scroll-button]]/conversation:[mask-image:linear-gradient(to_bottom,black_calc(100%-3.5rem),transparent_calc(100%-2.25rem))]",
      )
    : undefined;

  // Gutters follow the column, not the screen: in a window with its sidebar
  // the column is narrower than the viewport (p-4 under 28rem, p-6 above)
  const columnGutter = "px-4 @md/assistant:px-6";

  const chatContent = showingChat ? (
    <Conversation className="flex-1 min-h-0" initial="smooth" resize="smooth">
      <ConversationContent
        scrollClassName={bottomFade}
        className={cn("mx-auto w-full max-w-2xl pt-4 pb-6 @md/assistant:pt-6", columnGutter)}
      >
        {messages.map((message, index) => (
          <ChatMessage
            key={`${message.id}-${index}`}
            message={message}
            onRegenerate={regenerate}
            onBlueprintUpdate={handleBlueprintUpdate}
            isLast={index === messages.length - 1}
            isStreaming={isActive && index === messages.length - 1}
          />
        ))}
        {pendingLabel && <ThinkingMessage label={pendingLabel} />}
        {error && <AssistantChatError error={error} provider={activeProvider} onDismiss={clearError} />}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  ) : (
    // Centred while it fits (auto margins), scrolls from the top when it doesn't.
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none", bottomFade)}>
      <div className={cn("m-auto w-full max-w-2xl pt-4 pb-6 @md/assistant:pt-6", columnGutter)}>
        <div className="flex w-full flex-col items-center">
          {error ? (
            <div className="w-full max-w-md mb-6">
              <AssistantChatError error={error} provider={activeProvider} onDismiss={clearError} />
            </div>
          ) : null}
          <div className="mb-4 flex size-12 items-center justify-center" aria-hidden>
            <ThinkingOrb state="breathing" size={32} />
          </div>
          {/* Where focus lands on a touch screen once Delete has emptied the
              list below (the composer would raise the on-screen keyboard) */}
          <h2
            tabIndex={-1}
            data-assistant-home=""
            className="mb-6 text-center text-2xl font-medium tracking-tight text-foreground outline-none @md/assistant:mb-8"
          >
            How can I help?
          </h2>

          {/* Two columns from 20rem; a label wraps to a second line rather
              than losing its end in a narrow window */}
          <div className="tm-rise mb-8 grid w-full max-w-xl grid-cols-1 gap-2 @xs/assistant:grid-cols-2">
            {suggestions.map((s, i) => (
              <button
                key={`${i}-${s.label}`}
                type="button"
                onClick={() => handleSuggestion(s.prompt)}
                className="group/suggestion flex min-h-11 items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2.5 text-left text-sm text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-foreground/7 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:bg-foreground/8 motion-safe:active:scale-98 @md/assistant:px-4"
              >
                <span className="line-clamp-2 min-w-0 flex-1">{s.label}</span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={14}
                  aria-hidden="true"
                  className="shrink-0 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/suggestion:opacity-60 motion-safe:-translate-x-1 motion-safe:group-hover/suggestion:translate-x-0"
                />
              </button>
            ))}
          </div>

          {conversations.some((conv) => !pendingDeletes.has(conv.id)) && (
            <div className={`w-full max-w-xl ${WINDOW_SIDEBAR_REPLACES}`}>
              {Object.entries(grouped).map(([group, convs]) => {
                // Chats waiting on Undo leave the list before it is cut to
                // length, so the group still shows its first three and its
                // "Show N more" counts what is really left; a group they
                // emptied goes too, as in the window sidebar
                const live = convs.filter((conv) => !pendingDeletes.has(conv.id));
                if (live.length === 0) return null;
                const isExpanded = !!expandedGroups[group];
                const visibleConvs = isExpanded ? live : live.slice(0, MAX_VISIBLE_HISTORY_PER_GROUP);
                const hiddenCount = Math.max(0, live.length - visibleConvs.length);

                return (
                  <div key={group} className="pb-1.5">
                    <div className="px-1 pb-1.5 pt-3 first:pt-0 text-xs font-medium text-muted-foreground">
                      {group}
                    </div>
                    {visibleConvs.map((conv) => (
                      <div
                        key={conv.id}
                        data-chat-history-row=""
                        data-chat-id={conv.id}
                        className="group/item flex items-center rounded-lg text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent/30 hover:text-foreground focus-within:bg-accent/30"
                      >
                        <button
                          type="button"
                          onClick={() => { setActiveId(conv.id); setDismissed(false); }}
                          title={conv.title}
                          className="flex min-w-0 flex-1 items-center rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent/40 sm:py-2.5"
                        >
                          <span className="flex-1 truncate">{conv.title}</span>
                          {conv.platform === "telegram" && (
                            <span className="ml-2 shrink-0 text-xs text-muted-foreground">Telegram</span>
                          )}
                          {conv.platform === "discord" && (
                            <span className="ml-2 shrink-0 text-xs text-muted-foreground">Discord</span>
                          )}
                        </button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Delete "${conv.title}"`}
                              onClick={() => requestDelete(conv.id, conv.title || "Untitled conversation", "history")}
                              className="mr-1 shrink-0 text-muted-foreground hover:text-status-critical sm:opacity-0 sm:group-hover/item:opacity-100 sm:group-focus-within/item:opacity-100 sm:focus-visible:opacity-100 phone-touch:size-11 pointer-coarse:opacity-100"
                            >
                              <HugeiconsIcon icon={Delete01Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="text-xs">Delete</TooltipContent>
                        </Tooltip>
                      </div>
                    ))}
                    {live.length > MAX_VISIBLE_HISTORY_PER_GROUP && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className="mt-1 mb-2 w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground outline-none transition-colors duration-150 ease-out hover:bg-accent/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring phone-touch:min-h-11"
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
      onVoiceMode={() => setVoiceOpen(true)}
      placeholder="Ask Talome anything…"
      // The keyboard toggle decides only where it shows (touch screens);
      // elsewhere the browser keeps its own choice
      inputMode={keyboard.showToggle ? keyboard.inputMode : undefined}
      extraTools={
        <>
          <AssistantModelSelector
            model={model}
            modelOptions={modelOptions}
            modelReady={modelReady}
            onModelChange={setModel}
          />
          <ComposerKeyboardToggle mode={keyboard.mode} shown={keyboard.showToggle} onToggle={keyboard.toggle} />
        </>
      }
    />
  );

  // In a desktop window, chat history stays one click away in a sidebar
  const sidebar = (
    <SourceList label="Chats">
      <SourceListSection>
        <SourceListItem
          icon={Add01Icon}
          label="New chat"
          active={!showingChat}
          onSelect={() => void handleNew()}
          data-new-chat=""
        />
      </SourceListSection>
      {Object.entries(grouped).map(([group, convs]) => {
        // Chats waiting on Undo leave the list; a section they emptied goes too
        const visible = convs.filter((conv) => !pendingDeletes.has(conv.id));
        if (visible.length === 0) return null;
        return (
          <SourceListSection key={group} title={group}>
            {visible.map((conv) => (
              <ChatSourceItem
                key={conv.id}
                conversation={conv}
                active={showingChat && activeId === conv.id}
                onSelect={() => { setActiveId(conv.id); setDismissed(false); }}
                // Same undoable delete as the classic history list, from the
                // row's button (hover, focus, the open chat) and its context menu
                action={{
                  icon: Delete01Icon,
                  label: `Delete "${chatTitle(conv)}"`,
                  onSelect: () => requestDelete(conv.id, chatTitle(conv), "sidebar"),
                }}
              />
            ))}
          </SourceListSection>
        );
      })}
    </SourceList>
  );

  return (
    <WindowSidebarLayout sidebar={voiceOpen ? null : sidebar}>
    {/* Outside the container below: it is a fixed full-screen overlay, and a
        size container is the containing block for fixed descendants */}
    <VoiceMode
      open={voiceOpen}
      onClose={() => setVoiceOpen(false)}
      onSend={sendVoiceMessage}
      status={status as ChatStatus}
      lastAssistant={lastAssistant}
      history={voiceHistory}
    />
    {/* A named container: gutters and the suggestion grid follow this column's
        width, which in a window is narrower than the screen */}
    <div className="@container/assistant flex-1 min-h-0 flex flex-col overflow-hidden overscroll-none">
      {embeddedFrame ? (
        // The window's toolbar row (it hides while the sidebar shows)
        showingChat && <AssistantToolbar onNew={() => void handleNewFromChat()} />
      ) : (
        <AssistantHeader
          showingChat={showingChat}
          backToOrigin={origin !== null}
          onBack={handleBack}
          onNew={() => void handleNewFromChat()}
        />
      )}
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
      {/* Bottom section: blueprint bar + input. In a window the space under
          the input matches the window's gutter (the bar brings 0.75rem). */}
      {showInputBar && (
        <div className={cn("relative shrink-0", embeddedFrame && "pb-[calc(var(--window-pad,1rem)-0.75rem)]")}>
          {hasBlueprint && showingChat && (
            <div className={cn("mx-auto w-full max-w-2xl pb-2 pt-1", columnGutter)}>
              {buildError && <Alert variant="destructive" className="mb-2">
                <AlertTitle>Build could not start</AlertTitle>
                <AlertDescription>
                  <p>{buildError}</p>
                  <p>Your blueprint is still available. Use Build to retry.</p>
                </AlertDescription>
              </Alert>}
              <BlueprintDraftBar
                blueprint={blueprint}
                onBuild={handleBlueprintBuild}
                building={building}
                onDismiss={handleDismissBlueprint}
              />
            </div>
          )}
          {inputBar}
        </div>
      )}
    </div>
    </WindowSidebarLayout>
  );
}
