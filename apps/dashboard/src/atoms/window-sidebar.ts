import { atom } from "jotai";

/**
 * Where a windowed app's sidebar renders: a slot the desktop window shell
 * places beside the app, outside its padded scroll area, so the sidebar runs
 * edge to edge and stays put while the app scrolls.
 */
export const windowSidebarSlotAtom = atom<HTMLElement | null>(null);
