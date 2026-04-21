import { atom } from "jotai";

/** Overrides the header title for pages that want a dynamic label (e.g. app detail). */
export const pageTitleAtom = atom<string | null>(null);
