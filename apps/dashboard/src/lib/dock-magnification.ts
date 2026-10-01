/**
 * Dock magnification, tuned to feel like the macOS Dock: icons near the
 * pointer grow from the shelf, their neighbours make room (the Dock widens),
 * and the size follows the pointer almost directly — no visible lag, no
 * overshoot.
 */

/** Resting size of a Dock item, in px (Tailwind size-12). */
export const DOCK_ICON_SIZE = 48;

/** Icons within this distance (px) of the pointer grow… */
export const DOCK_MAGNIFY_RADIUS = 140;

/** …peaking at 1 + this amount, right under the pointer. */
export const DOCK_MAGNIFY_AMOUNT = 0.4;

/**
 * Near-critically damped (ratio ≈ 1.05): the size reaches 95% of its target
 * in about 75ms and never overshoots, so moving along the Dock reads as direct
 * tracking, and entering or leaving it as a quick grow or settle.
 */
export const DOCK_MAGNIFY_SPRING = { stiffness: 1600, damping: 53, mass: 0.4 } as const;

/** Scale of an item whose centre is `distance` px from the pointer (cosine falloff). */
export function dockMagnification(distance: number): number {
  if (!Number.isFinite(distance) || Math.abs(distance) >= DOCK_MAGNIFY_RADIUS) return 1;
  return 1 + DOCK_MAGNIFY_AMOUNT * (Math.cos((Math.PI * distance) / DOCK_MAGNIFY_RADIUS) + 1) / 2;
}
