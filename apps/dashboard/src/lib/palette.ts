/**
 * One way to open the command palette from anywhere in the shell.
 *
 * Callers used to dispatch a synthetic ⌘K keydown, which toggled the palette
 * (so a second click closed it), could not choose a mode, and reached a
 * different palette depending on which document had focus. `openPalette()`
 * sends a DOM event that the palette (or its launcher, before the palette
 * chunk has loaded) listens for, and always opens.
 */
export const OPEN_PALETTE_EVENT = "talome:open-palette";

export type PaletteMode = "search" | "chat";

export interface OpenPaletteDetail {
  mode: PaletteMode;
  prefill?: string;
}

export function openPalette(detail: Partial<OpenPaletteDetail> = {}): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(
    new CustomEvent<OpenPaletteDetail>(OPEN_PALETTE_EVENT, {
      detail: { mode: detail.mode ?? "search", prefill: detail.prefill },
    }),
  );
}

/** Reads a palette request from an event, or null when it isn't one. */
export function paletteRequestFromEvent(event: Event): OpenPaletteDetail | null {
  if (event.type !== OPEN_PALETTE_EVENT) return null;
  const detail = (event as CustomEvent<Partial<OpenPaletteDetail> | undefined>).detail;
  const mode: PaletteMode = detail?.mode === "chat" ? "chat" : "search";
  const prefill = typeof detail?.prefill === "string" ? detail.prefill : undefined;
  return { mode, prefill };
}
