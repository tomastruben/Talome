import { describe, expect, it } from "vitest";
import {
  DOCK_MAGNIFY_AMOUNT,
  DOCK_MAGNIFY_RADIUS,
  DOCK_MAGNIFY_SPRING,
  dockMagnification,
} from "@/lib/dock-magnification";

/** Simulate the spring from 1 to the peak; return the ms to reach 95% and the largest value seen. */
function settle({ stiffness, damping, mass }: typeof DOCK_MAGNIFY_SPRING) {
  const target = 1 + DOCK_MAGNIFY_AMOUNT;
  let x = 1;
  let v = 0;
  let peak = x;
  let t95: number | null = null;
  const dt = 1 / 1000;
  for (let step = 1; step <= 1000; step++) {
    const a = (-stiffness * (x - target) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
    peak = Math.max(peak, x);
    if (t95 === null && x >= 1 + 0.95 * DOCK_MAGNIFY_AMOUNT) t95 = step;
  }
  return { t95, peak, target };
}

describe("Dock magnification (macOS-like)", () => {
  it("peaks under the pointer and fades to rest at the radius", () => {
    expect(dockMagnification(0)).toBeCloseTo(1 + DOCK_MAGNIFY_AMOUNT);
    expect(dockMagnification(DOCK_MAGNIFY_RADIUS)).toBe(1);
    expect(dockMagnification(-DOCK_MAGNIFY_RADIUS - 1)).toBe(1);
    expect(dockMagnification(Number.POSITIVE_INFINITY)).toBe(1);
    // Symmetric and monotonic away from the pointer
    expect(dockMagnification(40)).toBeCloseTo(dockMagnification(-40));
    expect(dockMagnification(20)).toBeGreaterThan(dockMagnification(60));
  });

  it("never overshoots: the spring is at least critically damped", () => {
    const { stiffness, damping, mass } = DOCK_MAGNIFY_SPRING;
    expect(damping / (2 * Math.sqrt(stiffness * mass))).toBeGreaterThanOrEqual(1);
    const { peak, target } = settle(DOCK_MAGNIFY_SPRING);
    expect(peak).toBeLessThanOrEqual(target + 1e-6);
  });

  it("follows the pointer quickly: 95% of the way in under 100ms", () => {
    const { t95 } = settle(DOCK_MAGNIFY_SPRING);
    expect(t95).not.toBeNull();
    expect(t95!).toBeLessThan(100);
  });
});
