"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";

interface ChatNavActions {
  goHome: () => void;
  startNew: () => void;
  title?: string;
}

interface ChatNavState {
  inConversation: boolean;
  title: string | undefined;
  goHome: () => void;
  startNew: () => void;
  register: (state: ChatNavActions) => void;
  unregister: () => void;
}

const ChatNavContext = createContext<ChatNavState>({
  inConversation: false,
  title: undefined,
  goHome: () => {},
  startNew: () => {},
  register: () => {},
  unregister: () => {},
});

export function ChatNavProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ChatNavActions | null>(null);

  const register = useCallback((state: ChatNavActions) => {
    setActions(state);
  }, []);

  const unregister = useCallback(() => {
    setActions(null);
  }, []);

  return (
    <ChatNavContext.Provider
      value={{
        inConversation: !!actions,
        title: actions?.title,
        goHome: actions?.goHome ?? (() => {}),
        startNew: actions?.startNew ?? (() => {}),
        register,
        unregister,
      }}
    >
      {children}
    </ChatNavContext.Provider>
  );
}

export const useChatNav = () => useContext(ChatNavContext);
