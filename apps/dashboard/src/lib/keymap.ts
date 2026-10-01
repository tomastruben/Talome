/**
 * The shell's keyboard shortcuts: the single source for every hint shown in
 * the palette, menus and tooltips. A hint appears only for a shortcut listed
 * here, and each entry here has a registered handler (the file named in
 * `handledIn`, checked by `__tests__/shell-honesty.test.ts`).
 *
 * Browser-reserved combinations (⌘1–9, ⌘T, ⌘W, ⌘N) are never used: the
 * browser takes them before the page sees them.
 */
export interface Shortcut {
  /** What a person reads: "⌘K". */
  hint: string;
  /** What it does, in the words of the menu item it decorates. */
  label: string;
  /** Source file (relative to `src/`) that registers the key handler. */
  handledIn: string;
  /** Returns true when a keydown event is this shortcut. */
  matches: (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">) => boolean;
}

export const SHORTCUTS = {
  palette: {
    hint: "⌘K",
    label: "Search",
    handledIn: "components/assistant/command-palette.tsx",
    matches: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k",
  },
  chat: {
    hint: "/",
    label: "Ask Talome",
    handledIn: "components/assistant/command-palette.tsx",
    matches: (e) => e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey,
  },
  bugHunt: {
    hint: "⇧⌘X",
    label: "Bug Hunt",
    handledIn: "components/bug-hunt/bug-hunt-launcher.tsx",
    matches: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x",
  },
  filesSearch: {
    hint: "⌘F",
    label: "Search in Files",
    handledIn: "app/dashboard/files/page.tsx",
    matches: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f",
  },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Every hint the shell may display. */
export const SHORTCUT_HINTS: readonly string[] = Object.values(SHORTCUTS).map((s) => s.hint);
