/**
 * Desktop-mode stacking layers (spec §2.10), in one place instead of
 * scattered literals. Windows use `desktopWindowZIndex(rank)` from
 * lib/desktop-window-state.ts: 100 + rank, always below the dock.
 */
export const DESKTOP_LAYER = {
  wallpaper: 0,
  widgets: 10,
  windowBase: 100,
  widgetEditScrim: 1000,
  dock: 1050,
  menuBar: 1100,
  widgetEditToolbar: 1200,
  menuBarPopover: 1300,
  menus: 1400,
} as const;
