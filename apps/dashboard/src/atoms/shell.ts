import { atom } from "jotai";

/** When true, the dashboard shell hides its SiteHeader so the page can render its own. */
export const hideShellHeaderAtom = atom(false);
