import { atom } from "jotai";

/**
 * Where a windowed app's sidebar renders: the window's sidebar panel, which
 * the desktop window shell places beside the app, outside its padded scroll
 * area, inset from the window's edges and full height, so the sidebar stays
 * put while the app scrolls. Its top is left for the window controls.
 */
export const windowSidebarSlotAtom = atom<HTMLElement | null>(null);

/**
 * Where a windowed app's toolbar renders (<DesktopAppToolbar>): a slot in the
 * window's unified toolbar, after Back and the title and above the app's
 * scroller, so the toolbar never scrolls away and needs no sticky
 * positioning or backdrop of its own.
 */
export const windowToolbarSlotAtom = atom<HTMLElement | null>(null);

/**
 * Where a windowed app's status bar renders (<WindowStatusBar>): a slot below
 * the app's scroller, inside the window's bottom edge.
 */
export const windowStatusBarSlotAtom = atom<HTMLElement | null>(null);
