"use client";

import { useEffect, useState } from "react";

/**
 * How many pixels of the screen the on-screen keyboard covers. iOS Safari
 * shrinks only the visual viewport when the keyboard opens (the layout
 * viewport, and so `100dvh`, stay full height), so content anchored low on the
 * screen ends up behind the keyboard unless it makes room itself. 0 when no
 * keyboard is showing or the browser has no visualViewport.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
        // Ignore small differences (browser chrome settling), only a keyboard counts
        setInset(covered > 80 ? covered : 0);
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
