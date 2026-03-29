import { atom } from "jotai";
import type { ReactNode } from "react";

/** Allows pages to inject a custom action into the site header. */
export const pageActionAtom = atom<ReactNode>(null);
