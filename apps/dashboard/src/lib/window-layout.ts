/**
 * How a desktop window's content column treats an app (dashboard-shell.tsx):
 *
 * - "fill": the app owns its panes and its single scroller, edge to edge with
 *   no shell padding (Files, Assistant, Terminal, the player).
 * - "page": the shell's `.tm-window-scroll` pads the page with `--window-pad`
 *   and scrolls it. Pages never add their own `h-full overflow-y-auto` wrapper.
 */
export type WindowContentLayout = "page" | "fill";

export const FILL_ROUTES = [
  "/dashboard/files",
  "/dashboard/containers/preview",
  "/dashboard/assistant",
  "/dashboard/terminal",
  "/dashboard/player",
] as const;

export function windowContentLayout(pathname: string): WindowContentLayout {
  return FILL_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))
    ? "fill"
    : "page";
}
