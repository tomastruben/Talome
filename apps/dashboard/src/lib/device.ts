/**
 * How Talome sits on a screen it's opened full screen on.
 *
 * A web app opened from the iOS or iPadOS Home Screen gets iOS's solid status
 * bar, coloured by `theme-color` (kept on the theme chosen in Talome by
 * ThemeColorSync), and the page starts below it. It is deliberately not the
 * translucent style that draws the page under the status bar: iOS 26 blurs
 * whatever sits in the band under a translucent status bar (the header's title
 * and buttons, a window's title) and sizes the layout viewport a status bar
 * short of the bottom, leaving a dead band above the home indicator. Only the
 * home indicator still overlays the page; `env(safe-area-inset-bottom)` keeps
 * content and the Dock clear of it, and is 0 everywhere else.
 */
export const APPLE_STATUS_BAR_STYLE = "default" as const;

/**
 * Runs in <head> before first paint: marks <html data-embedded-frame> inside a
 * desktop window, whose page background then turns transparent so the
 * window's frosted glass shows through.
 */
export const FRAME_SCRIPT = `(function(){try{if(window.self!==window.top)document.documentElement.setAttribute("data-embedded-frame","");}catch(e){}})();`;
