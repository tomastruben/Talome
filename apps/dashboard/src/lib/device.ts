/**
 * Which screens draw a system status bar over Talome.
 *
 * Only iPadOS and iOS put their status bar (time, battery) over a web app
 * opened full screen from the Home Screen. Everywhere else (a browser tab, a
 * desktop PWA on macOS, Windows or Linux) Talome owns the whole screen, so it
 * shouldn't leave room at the top.
 */

export interface DeviceSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Safari's navigator.standalone */
  standalone?: boolean;
  /** display-mode is standalone or fullscreen */
  displayModeStandalone: boolean;
}

export function isAppleTouchDevice(signals: Pick<DeviceSignals, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  if (/iPad|iPhone|iPod/.test(signals.userAgent)) return true;
  // iPadOS asks for desktop sites and reports itself as a Mac; a Mac has no touch screen
  return signals.platform === "MacIntel" && signals.maxTouchPoints > 1;
}

/** True when the iOS or iPadOS status bar is drawn over the page. */
export function hasOverlaidStatusBar(signals: DeviceSignals): boolean {
  const fullScreen = signals.standalone === true || signals.displayModeStandalone;
  return fullScreen && isAppleTouchDevice(signals);
}

/**
 * Runs in <head> before first paint: marks <html data-status-bar="ios"> so CSS
 * can keep content clear of the status bar without a layout jump, and
 * <html data-embedded-frame> inside a desktop window, whose page background
 * then turns transparent so the window's frosted glass shows through. A plain
 * string mirroring hasOverlaidStatusBar (it can't import modules).
 */
export const STATUS_BAR_SCRIPT = `(function(){try{if(window.self!==window.top)document.documentElement.setAttribute("data-embedded-frame","");var n=navigator;var apple=/iPad|iPhone|iPod/.test(n.userAgent)||(n.platform==="MacIntel"&&n.maxTouchPoints>1);var full=n.standalone===true||matchMedia("(display-mode: standalone)").matches||matchMedia("(display-mode: fullscreen)").matches;if(apple&&full)document.documentElement.setAttribute("data-status-bar","ios");}catch(e){}})();`;
