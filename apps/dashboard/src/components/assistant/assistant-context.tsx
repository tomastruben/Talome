"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import useSWR, { mutate } from "swr";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";
import { POLL_SLOW_MS } from "@/lib/polling";
import type { FileUIPart, UIMessage } from "ai";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConversationItem {
  id: string;
  title: string;
  platform: string;
  externalId: string | null;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

// ── Context ──────────────────────────────────────────────────────────────────

export type ChatModel = string;

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

export interface AssistantContextValue {
  // Conversation list
  conversations: ConversationItem[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /** Deletes on the server. Resolves false (and restores the list) when it failed. */
  /** `keepalive` lets the request finish after the page unloads. */
  deleteConversation: (id: string, options?: { keepalive?: boolean }) => Promise<boolean>;

  // Chat state
  messages: UIMessage[];
  status: string;
  error: Error | undefined;
  clearError: () => void;
  stop: () => void;
  setMessages: (messages: UIMessage[]) => void;
  regenerate: () => void;

  // Model selection
  model: ChatModel;
  setModel: (model: ChatModel) => void;
  modelOptions: ModelOption[];
  activeProvider: string;
  /** True once the backend model/provider selection has populated request refs. */
  modelReady: boolean;

  // Actions
  handleSubmit: (
    text: string,
    pageContext?: string,
    files?: FileUIPart[]
  ) => Promise<void>;
  startNew: () => void;

  // Tool approvals are never decided here: core returns `approval_required`
  // (ai/execution.ts), the approval card shows it, and an admin decides it
  // through the approvals API. There is no client-side auto-approve.

  // Submission state — true while a send is in progress (prevents double-sends)
  isSubmitting: boolean;

  // Palette control — open the command palette in chat mode
  openPaletteInChatMode: (prefill?: string) => void;
  registerOpenPalette: (fn: (prefill?: string) => void) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export const useAssistant = () => {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside AssistantProvider");
  return ctx;
};

// ── Provider ─────────────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const STORED_UI_MESSAGE_KIND = "ui-message-v1";

function getTextFromParts(parts: UIMessage["parts"]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function serializeStoredMessage(parts: UIMessage["parts"]): string {
  const text = getTextFromParts(parts);

  if (parts.every((part) => part.type === "text")) {
    return text;
  }

  return JSON.stringify({
    kind: STORED_UI_MESSAGE_KIND,
    parts,
    text,
  });
}

function deserializeStoredMessage(content: string): UIMessage["parts"] {
  try {
    const parsed = JSON.parse(content) as {
      kind?: string;
      parts?: UIMessage["parts"];
      text?: string;
    };

    if (parsed.kind === STORED_UI_MESSAGE_KIND && Array.isArray(parsed.parts)) {
      return parsed.parts;
    }
  } catch {
    // Fall back to plain text rows created before attachments existed.
  }

  return content ? [{ type: "text", text: content }] : [];
}

interface AiModelsResponse {
  activeProvider: string;
  activeModel: string;
  providers: Array<{
    provider: string;
    configured: boolean;
    models: Array<{ id: string; name: string; description: string }>;
  }>;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi",
  ollama: "Ollama",
};

/** Generate a short random key for idempotency. */
function idempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Options for every configured provider — active provider first. */
function buildModelOptions(config: AiModelsResponse): ModelOption[] {
  const allOptions: ModelOption[] = [];
  const activeFirst = [
    ...config.providers.filter((p) => p.provider === config.activeProvider),
    ...config.providers.filter((p) => p.provider !== config.activeProvider),
  ];
  const usableProviders = activeFirst.filter((pp) => pp.configured && pp.models.length > 0).length;
  for (const p of activeFirst) {
    if (!p.configured || p.models.length === 0) continue;
    const label = PROVIDER_LABELS[p.provider] ?? p.provider;
    for (const m of p.models) {
      // Prefix name with provider when showing cross-provider options
      const name = usableProviders > 1 ? `${label} ${m.name}` : m.name;
      allOptions.push({ id: m.id, name, provider: p.provider, description: m.description });
    }
  }
  return allOptions;
}

interface ChatRequestBody {
  model: ChatModel;
  provider: string;
}

/**
 * Builds the chat transport together with the per-request body it sends.
 * The body lives in this closure (not a React ref) so it can be read lazily
 * at request time — including automatic resends — while effects keep it in
 * sync with the selected model/provider. `getConversationId` is also read at
 * request time so the server can key its per-conversation caches.
 */
function createChatRequest(initial: ChatRequestBody) {
  let body: ChatRequestBody = { ...initial };
  let conversationId: string | null = null;
  const transport = new DefaultChatTransport({
    api: `${getDirectCoreUrl()}/api/chat`,
    credentials: "include",
    body: () => (conversationId ? { ...body, conversationId } : { ...body }),
  });
  return {
    transport,
    update(patch: Partial<ChatRequestBody>) {
      body = { ...body, ...patch };
    },
    /** Set synchronously wherever the active conversation changes (before any send). */
    setConversationId(id: string | null) {
      conversationId = id;
    },
  };
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  // The user's explicit pick; the effective model is derived below once the
  // server's model config is known.
  const [selectedModel, setModel] = useState<ChatModel>("");
  // Created once: useChat only reads the transport when it creates its Chat
  // instance; the request body is kept current by the effects below.
  const [chatRequest] = useState(() =>
    createChatRequest({ model: "", provider: "anthropic" })
  );

  // Submission mutex — prevents double-sends during network latency
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // Fetch active model config from server
  const { data: modelsConfig } = useSWR<AiModelsResponse>(
    `${CORE_URL}/api/ai/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );

  const hasModelsConfig = !!modelsConfig?.providers;
  const modelOptions = useMemo(
    () => (modelsConfig?.providers ? buildModelOptions(modelsConfig) : []),
    [modelsConfig],
  );
  // Keep the user's pick while it is offered; otherwise use the server's active model.
  const model: ChatModel =
    hasModelsConfig && !(selectedModel && modelOptions.some((o) => o.id === selectedModel))
      ? modelsConfig.activeModel
      : selectedModel;
  // Provider of the effective model (models can come from any configured
  // provider); falls back to the server's active provider.
  const activeProvider =
    modelOptions.find((o) => o.id === model)?.provider
    ?? (hasModelsConfig ? modelsConfig.activeProvider : "anthropic");

  useEffect(() => {
    activeIdRef.current = activeId;
    chatRequest.setConversationId(activeId);
  }, [activeId, chatRequest]);

  useEffect(() => {
    chatRequest.update({ model });
  }, [chatRequest, model]);

  useEffect(() => {
    // Track the provider of the selected model
    if (hasModelsConfig) chatRequest.update({ provider: activeProvider });
  }, [chatRequest, hasModelsConfig, activeProvider]);

  // True once the server's model config is known. The request body above is
  // synced in this same commit's effects, which all flush before handleSubmit's
  // first await resumes — so a prompt arriving from the URL uses the right model.
  const modelReady = hasModelsConfig;

  // Holds a reference to the CommandPalette's open-in-chat-mode function,
  // registered once the palette mounts.
  const openPaletteRef = useRef<((prefill?: string) => void) | null>(null);

  const registerOpenPalette = useCallback((fn: (prefill?: string) => void) => {
    openPaletteRef.current = fn;
  }, []);

  const openPaletteInChatMode = useCallback((prefill?: string) => {
    openPaletteRef.current?.(prefill);
  }, []);

  // Local changes (new conversation, title, delete) call mutate() directly;
  // polling only picks up changes made elsewhere, so it can be slow.
  const { data: conversationList } = useSWR<ConversationItem[]>(
    `${CORE_URL}/api/conversations`,
    fetcher,
    { refreshInterval: POLL_SLOW_MS }
  );

  const { data: storedMessages } = useSWR<StoredMessage[]>(
    activeId ? `${CORE_URL}/api/conversations/${activeId}/messages` : null,
    fetcher
  );

  const retryCountRef = useRef(0);
  const MAX_AUTO_RETRIES = 3;

  const {
    messages,
    sendMessage,
    status,
    setMessages,
    stop,
    regenerate,
    error,
    clearError,
  } = useChat({
    transport: chatRequest.transport,
    onFinish: ({ message }) => {
      retryCountRef.current = 0;
      submittingRef.current = false;
      setIsSubmitting(false);

      const convId = activeIdRef.current;
      if (!convId || message.role !== "assistant") return;
      const content = serializeStoredMessage(message.parts);
      const text = getTextFromParts(message.parts);
      if (content) {
        fetch(`${CORE_URL}/api/conversations/${convId}/messages`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: "assistant",
            content,
            idempotencyKey: `assist-${message.id}`,
          }),
        });
        fetch(`${CORE_URL}/api/conversations/${convId}/title`, {
          method: "POST",
          credentials: "include",
        }).then(() => mutate(`${CORE_URL}/api/conversations`));
        // Background memory extraction — fire and forget
        if (text.length > 100) {
          fetch(`${CORE_URL}/api/memories/extract`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId: convId, text }),
          });
        }
      }
    },
    onError: () => {
      // Release submission lock on error so user can retry
      submittingRef.current = false;
      setIsSubmitting(false);
    },
    // No `sendAutomaticallyWhen`: core never marks a tool `needsApproval`, so
    // there are no AI SDK approval responses to resend. A call held for the
    // owner comes back as an `approval_required` tool result instead.
  });

  // Auto-retry on network error (e.g. server restarted mid-stream while a
  // tool was running). Wait for the server to come back up, then regenerate.
  useEffect(() => {
    if (!error) return;
    const isNetworkError =
      error.message?.toLowerCase().includes("network") ||
      error.message?.toLowerCase().includes("fetch") ||
      error.message?.toLowerCase().includes("failed to fetch") ||
      error.message?.toLowerCase().includes("connection");

    if (!isNetworkError) return;
    if (retryCountRef.current >= MAX_AUTO_RETRIES) return;

    // Only retry if the last message was from the assistant (mid-stream)
    const lastMsg = messages.at(-1);
    if (!lastMsg || lastMsg.role !== "assistant") return;

    retryCountRef.current += 1;
    const delay = 3000 * retryCountRef.current; // 3s, 6s, 9s back-off

    const timer = setTimeout(() => {
      clearError();
      regenerate();
    }, delay);

    return () => clearTimeout(timer);
  }, [error, messages, clearError, regenerate]);

  // Load stored messages when active conversation changes.
  // Guard: only process actual arrays — error objects from failed fetches
  // must not clear the in-memory messages.
  useEffect(() => {
    if (Array.isArray(storedMessages) && storedMessages.length > 0) {
      setMessages(
        storedMessages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          parts: deserializeStoredMessage(m.content),
          createdAt: new Date(m.createdAt),
        }))
      );
    } else if (activeId && Array.isArray(storedMessages)) {
      setMessages([]);
    }
  }, [storedMessages, activeId, setMessages]);

  const ensureConversation = useCallback(
    async (firstMessage: string, files: FileUIPart[] = []) => {
      if (activeIdRef.current) return activeIdRef.current;
      const title = firstMessage.trim() || files[0]?.filename || "New Conversation";
      const res = await fetch(`${CORE_URL}/api/conversations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.slice(0, 50) }),
      });
      const conv: ConversationItem = await res.json();
      setActiveIdState(conv.id);
      activeIdRef.current = conv.id;
      chatRequest.setConversationId(conv.id);
      mutate(`${CORE_URL}/api/conversations`);
      return conv.id;
    },
    [chatRequest]
  );

  const handleSubmit = useCallback(
    async (text: string, pageContext?: string, files: FileUIPart[] = []) => {
      const trimmedText = text.trim();
      if (!trimmedText && files.length === 0) return;

      // Mutex: prevent double-sends
      if (submittingRef.current) return;
      submittingRef.current = true;
      setIsSubmitting(true);
      clearError();

      const parts: UIMessage["parts"] = [
        ...(trimmedText ? [{ type: "text" as const, text: trimmedText }] : []),
        ...files,
      ];
      const msgKey = idempotencyKey();

      try {
        const convId = await ensureConversation(trimmedText, files);
        await fetch(`${CORE_URL}/api/conversations/${convId}/messages`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: "user",
            content: serializeStoredMessage(parts),
            idempotencyKey: msgKey,
          }),
        });
        sendMessage({
          role: "user",
          parts,
          ...(pageContext ? { data: { pageContext } } : {}),
        });
      } catch {
        // Release lock on failure — user can retry
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [clearError, ensureConversation, sendMessage]
  );

  const setActiveId = useCallback(
    (id: string | null) => {
      setActiveIdState(id);
      activeIdRef.current = id;
      chatRequest.setConversationId(id);
    },
    [chatRequest]
  );

  const startNew = useCallback(() => {
    stop();
    clearError();
    setActiveId(null);
    setMessages([]);
    submittingRef.current = false;
    setIsSubmitting(false);
  }, [stop, clearError, setActiveId, setMessages]);

  const deleteConversation = useCallback(
    async (id: string, options?: { keepalive?: boolean }): Promise<boolean> => {
      // Optimistic removal from conversation list
      mutate(
        `${CORE_URL}/api/conversations`,
        (current: ConversationItem[] | undefined) =>
          current ? current.filter((c) => c.id !== id) : [],
        false,
      );

      try {
        const res = await fetch(`${CORE_URL}/api/conversations/${id}`, {
          method: "DELETE",
          credentials: "include",
          ...(options?.keepalive ? { keepalive: true } : {}),
        });

        if (!res.ok) {
          // Rollback: revalidate from server
          mutate(`${CORE_URL}/api/conversations`);
          return false;
        }
      } catch {
        // Rollback on network error
        mutate(`${CORE_URL}/api/conversations`);
        return false;
      }

      // Revalidate to get authoritative state
      mutate(`${CORE_URL}/api/conversations`);

      if (activeIdRef.current === id) {
        setActiveId(null);
        setMessages([]);
      }
      return true;
    },
    [setActiveId, setMessages]
  );

  const conversations = useMemo(
    () => (Array.isArray(conversationList) ? conversationList : []),
    [conversationList]
  );

  const value = useMemo<AssistantContextValue>(
    () => ({
      conversations,
      activeId,
      setActiveId,
      deleteConversation,
      messages,
      status,
      error,
      clearError,
      stop,
      setMessages,
      regenerate,
      model,
      setModel,
      modelOptions,
      activeProvider,
      modelReady,
      handleSubmit,
      startNew,
      isSubmitting,
      openPaletteInChatMode,
      registerOpenPalette,
    }),
    [
      conversations, activeId, setActiveId, deleteConversation,
      messages, status, error, clearError, stop, setMessages,
      regenerate, model, setModel,
      modelOptions, activeProvider, modelReady,
      handleSubmit, startNew,
      isSubmitting,
      openPaletteInChatMode, registerOpenPalette,
    ]
  );

  return (
    <AssistantContext.Provider value={value}>
      {children}
    </AssistantContext.Provider>
  );
}
