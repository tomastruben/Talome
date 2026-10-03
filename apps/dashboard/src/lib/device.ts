/**
 * Keep the default status-bar presentation. Home Screen WebKit can still draw
 * a system blur over the page; globals.css reserves space for its controls.
 * Its extent is not exposed by safe-area-inset-top on every iOS version.
 */
export const APPLE_STATUS_BAR_STYLE = "default" as const;

/**
 * Runs in <head> before first paint: marks <html data-embedded-frame> inside a
 * desktop window, whose page background then turns transparent so the
 * window's frosted glass shows through.
 */
export const FRAME_SCRIPT = `(function(){try{if(window.self!==window.top)document.documentElement.setAttribute("data-embedded-frame","");if(/iPad/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)||(/Android/.test(navigator.userAgent)&&Math.min(screen.width,screen.height)>=600))document.documentElement.setAttribute("data-tablet-device","");if(/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1))document.documentElement.setAttribute("data-apple-touch-device","");}catch(e){}})();`;
