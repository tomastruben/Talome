import { atom } from "jotai";

/** Allows pages to show an animated back button in the header (like drilldown routes). */
export const pageBackAtom = atom<(() => void) | null>(null);
