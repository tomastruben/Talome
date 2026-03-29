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
}

export interface AssistantContextValue {
  // Conversation list
  conversations: ConversationItem[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  deleteConversation: (id: string) => Promise<void>;

  // Chat state
  messages: UIMessage[];
  status: string;
  error: Error | undefined;
  clearError: () => void;
  stop: () => void;
  setMessages: (messages: UIMessage[]) => void;
  addToolApprovalResponse: (params: { id: string; approved: boolean; reason?: string }) => void;
  regenerate: () => void;

  // Model selection
  model: ChatModel;
  setModel: (model: ChatModel) => void;
  modelOptions: ModelOption[];
  activeProvider: string;

  // Actions
  handleSubmit: (
    text: string,
    pageContext?: string,
    files?: FileUIPart[]
  ) => Promise<void>;
  startNew: () => void;

  // Auto mode — skip confirmation dialogs for destructive actions
  autoMode: boolean;
  setAutoMode: (enabled: boolean) => void;

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
  ollama: "Ollama",
};

/** Generate a short random key for idempotency. */
function idempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  const [model, setModel] = useState<ChatModel>("");
  const modelRef = useRef<ChatModel>(model);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [activeProvider, setActiveProvider] = useState("anthropic");
  const providerRef = useRef(activeProvider);

  // Auto mode: skip confirmation dialogs
  const [autoMode, setAutoModeState] = useState(false);
  const setAutoMode = useCallback((enabled: boolean) => {
    setAutoModeState(enabled);
    try { localStorage.setItem("talome-auto-mode", String(enabled)); } catch { /* noop */ }
  }, []);

  // Sync autoMode from localStorage after hydration
  useEffect(() => {
    try { setAutoModeState(localStorage.getItem("talome-auto-mode") === "true"); } catch { /* noop */ }
  }, []);

  // Submission mutex — prevents double-sends during network latency
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // Fetch active model config from server
  const { data: modelsConfig } = useSWR<AiModelsResponse>(
    `${CORE_URL}/api/ai/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!modelsConfig?.providers) return;
    setActiveProvider(modelsConfig.activeProvider);

    // Build options from ALL configured providers — active provider first
    const allOptions: ModelOption[] = [];
    const activeFirst = [
      ...modelsConfig.providers.filter((p) => p.provider === modelsConfig.activeProvider),
      ...modelsConfig.providers.filter((p) => p.provider !== modelsConfig.activeProvider),
    ];
    for (const p of activeFirst) {
      if (!p.configured || p.models.length === 0) continue;
      const label = PROVIDER_LABELS[p.provider] ?? p.provider;
      for (const m of p.models) {
        // Prefix name with provider when showing cross-provider options
        const name = activeFirst.filter((pp) => pp.configured && pp.models.length > 0).length > 1
          ? `${label} ${m.name}`
          : m.name;
        allOptions.push({ id: m.id, name, provider: p.provider });
      }
    }
    setModelOptions(allOptions);

    // Only set model if not already set or if it's not in the new options
    if (!model || !allOptions.some((o) => o.id === model)) {
      setModel(modelsConfig.activeModel);
    }
  }, [modelsConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    // Track current provider for the selected model
    const opt = modelOptions.find((o) => o.id === model);
    if (opt) providerRef.current = opt.provider;
  }, [model, modelOptions]);

  // Holds a reference to the CommandPalette's open-in-chat-mode function,
  // registered once the palette mounts.
  const openPaletteRef = useRef<((prefill?: string) => void) | null>(null);

  const registerOpenPalette = useCallback((fn: (prefill?: string) => void) => {
    openPaletteRef.current = fn;
  }, []);

  const openPaletteInChatMode = useCallback((prefill?: string) => {
    openPaletteRef.current?.(prefill);
  }, []);

  const { data: conversationList } = useSWR<ConversationItem[]>(
    `${CORE_URL}/api/conversations`,
    fetcher,
    { refreshInterval: 10000 }
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
    addToolApprovalResponse,
    error,
    clearError,
  } = useChat({
    transport: new DefaultChatTransport({
      api: `${getDirectCoreUrl()}/api/chat`,
      credentials: "include",
      body: () => ({ model: modelRef.current, provider: providerRef.current }),
    }),
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
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            part != null &&
            typeof part === "object" &&
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
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
      mutate(`${CORE_URL}/api/conversations`);
      return conv.id;
    },
    []
  );

  const handleSubmit = useCallback(
    async (text: string, pageContext?: string, files: FileUIPart[] = []) => {
      const trimmedText = text.trim();
      if (!trimmedText && files.length === 0) return;

      // Mutex: prevent double-sends
      if (submittingRef.current) return;
      submittingRef.current = true;
      setIsSubmitting(true);

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
    [ensureConversation, sendMessage]
  );

  const setActiveId = useCallback(
    (id: string | null) => {
      setActiveIdState(id);
      activeIdRef.current = id;
    },
    []
  );

  const startNew = useCallback(() => {
    stop();
    setActiveId(null);
    setMessages([]);
    submittingRef.current = false;
    setIsSubmitting(false);
  }, [stop, setActiveId, setMessages]);

  const deleteConversation = useCallback(
    async (id: string) => {
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
        });

        if (!res.ok) {
          // Rollback: revalidate from server
          mutate(`${CORE_URL}/api/conversations`);
          return;
        }
      } catch {
        // Rollback on network error
        mutate(`${CORE_URL}/api/conversations`);
        return;
      }

      // Revalidate to get authoritative state
      mutate(`${CORE_URL}/api/conversations`);

      if (activeIdRef.current === id) {
        setActiveId(null);
        setMessages([]);
      }
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
      addToolApprovalResponse,
      regenerate,
      model,
      setModel,
      modelOptions,
      activeProvider,
      handleSubmit,
      startNew,
      autoMode,
      setAutoMode,
      isSubmitting,
      openPaletteInChatMode,
      registerOpenPalette,
    }),
    [
      conversations, activeId, setActiveId, deleteConversation,
      messages, status, error, clearError, stop, setMessages,
      addToolApprovalResponse, regenerate, model, setModel,
      modelOptions, activeProvider,
      handleSubmit, startNew,
      autoMode, setAutoMode, isSubmitting,
      openPaletteInChatMode, registerOpenPalette,
    ]
  );

  return (
    <AssistantContext.Provider value={value}>
      {children}
    </AssistantContext.Provider>
  );
}
