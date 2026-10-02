/** Settings > Memory groups open like a disclosure: named state, turning chevron, animated rows. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "components/settings/sections/ai-memory.tsx"), "utf8");

describe("memory group disclosure", () => {
  it("announces its state and controls its rows", () => {
    expect(source).toMatch(/aria-expanded=\{isOpen\}/);
    expect(source).toMatch(/aria-controls=\{panelId\}/);
    expect(source).toMatch(/id=\{panelId\}/);
  });

  it("turns one chevron instead of swapping icons, with motion tokens and a reduced-motion fallback", () => {
    expect(source).not.toMatch(/ArrowDown01Icon/);
    expect(source).toMatch(/isOpen && "rotate-90"/);
    expect(source).toMatch(/motion-reduce:transition-none/);
    expect(source).toMatch(/height: "auto", opacity: 1, transition: enter\(\)/);
    expect(source).toMatch(/height: 0, opacity: 0, transition: exit\(\)/);
    expect(source).toMatch(/reduceMotion\s*\?\s*\{ opacity: 0 \}/);
  });

  it("is a 44px target on touch", () => {
    expect(source).toMatch(/pointer-coarse:min-h-11/);
  });
});
