import { atom } from "jotai";

/**
 * Where a windowed app's sidebar renders: a slot the desktop window shell
 * places beside the app, outside its padded scroll area, so the sidebar runs
 * edge to edge and stays put while the app scrolls.
 */
export const windowSidebarSlotAtom = atom<HTMLElement | null>(null);

/**
 * Where a windowed app's toolbar renders (<DesktopAppToolbar>): a slot above
 * the app's scroller, so the toolbar never scrolls away and needs no sticky
 * positioning or backdrop of its own.
 */
export const windowToolbarSlotAtom = atom<HTMLElement | null>(null);

/**
 * Where a windowed app's status bar renders (<WindowStatusBar>): a slot below
 * the app's scroller, inside the window's bottom edge.
 */
export const windowStatusBarSlotAtom = atom<HTMLElement | null>(null);
