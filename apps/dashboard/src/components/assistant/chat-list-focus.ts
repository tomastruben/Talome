/**
 * Where keyboard and screen-reader focus goes when a chat leaves one of the
 * Assistant's lists (Delete, with Undo). The row that held focus is gone, so
 * without this focus falls to <body> and the next Tab starts over at the top
 * of the page.
 *
 * Focus moves to the nearest chat still in the same list: the next one, else
 * the one before it. With none left it moves to the composer, except on a
 * touch screen, where focusing a text field raises the on-screen keyboard:
 * there it moves to the view's landing point instead ("New chat" in the
 * window sidebar, the "How can I help?" heading in the classic list).
 */

/** The two lists a chat can be deleted from */
export type ChatList = "history" | "sidebar";

/**
 * The attribute that marks a row of each list. Every row also carries
 * `data-chat-id`, and its first button opens the chat.
 */
export const CHAT_LIST_ROW = {
  /** The classic history list on the home view (phones, classic layout, narrow windows) */
  history: "data-chat-history-row",
  /** ChatSourceItem in the window sidebar */
  sidebar: "data-chat-row",
} as const satisfies Record<ChatList, string>;

/**
 * Marks where focus lands on a touch screen when a list has no chats left:
 * the sidebar's "New chat" row, and the home view's heading (tabIndex -1).
 */
export const CHAT_LIST_LANDING = {
  sidebar: "data-new-chat",
  history: "data-assistant-home",
} as const satisfies Record<ChatList, string>;

/** The composer's text field (PromptInputTextarea) */
const COMPOSER = 'textarea[name="message"]';

function focusLost(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || !active.isConnected;
}

function touchScreen(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Picks the element that should take focus once chat `id` has left `list`.
 * `order` is every chat in the order both lists show them (date groups,
 * newest first), so a chat a collapsed group reveals in its place counts as
 * the next one.
 */
export function chatFocusTarget(
  { id, list, order }: { id: string; list: ChatList; order: readonly string[] },
  doc: Document = document,
): HTMLElement | null {
  const rows = new Map<string, HTMLElement>();
  for (const row of doc.querySelectorAll<HTMLElement>(`[${CHAT_LIST_ROW[list]}][data-chat-id]`)) {
    const open = row.querySelector<HTMLElement>("button");
    if (row.dataset.chatId && row.dataset.chatId !== id && open) rows.set(row.dataset.chatId, open);
  }
  const index = order.indexOf(id);
  const nearest = index === -1 ? [] : [...order.slice(index + 1), ...order.slice(0, index).reverse()];
  for (const other of nearest) {
    const open = rows.get(other);
    if (open) return open;
  }
  const landing = doc.querySelector<HTMLElement>(`[${CHAT_LIST_LANDING[list]}]`);
  if (touchScreen()) return landing;
  return doc.querySelector<HTMLElement>(COMPOSER) ?? landing;
}

/**
 * Moves focus to the home view once New chat in the classic header or a
 * narrow window's toolbar has started a new chat: the button leaves the page
 * with the chat it belonged to, and would take focus with it. It lands in
 * the composer, or on a touch screen (where a focused field raises the
 * on-screen keyboard) on the "How can I help?" heading.
 */
export function focusHomeAfterNewChat(doc: Document = document): HTMLElement | null {
  if (!focusLost(doc)) return null;
  const home = doc.querySelector<HTMLElement>(`[${CHAT_LIST_LANDING.history}]`);
  const target = touchScreen() ? home : doc.querySelector<HTMLElement>(COMPOSER) ?? home;
  target?.focus();
  return target;
}

/**
 * Moves focus once chat `id` has left `list`, if the deleted row took focus
 * with it. Focus that is somewhere else (Safari doesn't focus a clicked
 * button, so it can still be in the composer) stays where it is. Run after
 * the row has gone from the page.
 */
export function restoreFocusAfterChatLeft(
  removed: { id: string; list: ChatList; order: readonly string[] },
  doc: Document = document,
): HTMLElement | null {
  if (!focusLost(doc)) return null;
  const target = chatFocusTarget(removed, doc);
  target?.focus();
  return target;
}
