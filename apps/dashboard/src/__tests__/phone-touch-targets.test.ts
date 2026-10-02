/**
 * Phone (classic) touch targets found by the lead's 375px audit: every control
 * a person taps in the shell header, the composer, settings rows and empty
 * states is 44px on a coarse pointer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

describe("phone touch targets (pointer-coarse 44px)", () => {
  it("classic header: navigation, Back and header verbs", () => {
    const header = read("components/layout/site-header.tsx");
    const navTrigger = /aria-label="Open navigation"/;
    expect(header).toMatch(navTrigger);
    // every small icon button and text button in the header grows on touch
    for (const cls of header.match(/className="size-[78][^"]*"/g) ?? []) expect(cls).toMatch(/pointer-coarse:size-11/);
    for (const cls of header.match(/className="h-7 gap-1\.5[^"]*"/g) ?? []) expect(cls).toMatch(/pointer-coarse:h-11/);
  });

  it("composer: buttons, menu triggers and Send", () => {
    const input = read("components/ai-elements/prompt-input.tsx");
    expect(input).toMatch(/pointer-coarse:size-11/);
    expect(input).toMatch(/size-9 rounded-full pointer-coarse:size-11/);
    // an icon-only composer control takes its name from a text tooltip
    expect(input).toMatch(/aria-label=\{tooltipName\(tooltip, props\)\}/);
    expect(read("components/assistant/assistant-model-selector.tsx")).toMatch(/pointer-coarse:h-11/);
  });

  it("switches get a 44px hit area on touch", () => {
    expect(read("components/ui/switch.tsx")).toMatch(/pointer-coarse:after:-inset-3/);
  });

  it("empty-state and status actions", () => {
    expect(read("app/dashboard/files/page.tsx")).toMatch(/size="sm" className="pointer-coarse:h-11" onClick=\{uploadFiles\}/);
    expect(read("components/system/services-section.tsx")).toMatch(/className="pointer-coarse:h-11" onClick=\{\(\) => void mutate\(\)\}>Retry/);
  });
});
