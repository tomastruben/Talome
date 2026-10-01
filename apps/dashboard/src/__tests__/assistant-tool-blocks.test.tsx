/**
 * An expanded tool call in the Assistant never takes over a window: long
 * parameters and results are capped with their own scroller and a
 * "Show all" / "Show less" toggle, JSON is compact wrapped monospace with
 * muted keys, labels are sentence case, and the blocks paint relative fills
 * (never the opaque code-block slab) so they read on window glass.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/desktop-navigation", () => ({ requestDesktopNavigation: vi.fn(() => true) }));
vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));

import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import {
  TOOL_BLOCK_CAP,
  ToolDataBlock,
  formatToolData,
  isEmptyToolData,
} from "@/components/ai-elements/tool-data";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";

/** jsdom has no layout: make every tool block report a height. */
function layout({ content, box }: { content: number; box: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-tool-block") ? content : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute("data-tool-block")) return 0;
    return this.hasAttribute("data-expanded") ? content : box;
  });
}

const longResult = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`key_${i}`, `value ${i}`]));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool data formatting", () => {
  it("pretty-prints objects and JSON strings, and leaves other text alone", () => {
    expect(formatToolData({ a: 1, b: [true] })).toEqual({ text: '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}', json: true });
    expect(formatToolData('{"ok":true}')).toEqual({ text: '{\n  "ok": true\n}', json: true });
    expect(formatToolData("Container sonarr restarted.")).toEqual({ text: "Container sonarr restarted.", json: false });
    expect(formatToolData("{not json")).toEqual({ text: "{not json", json: false });
    expect(formatToolData(42)).toEqual({ text: "42", json: true });
  });

  it("treats a call without arguments as having no parameters", () => {
    expect(isEmptyToolData(undefined)).toBe(true);
    expect(isEmptyToolData(null)).toBe(true);
    expect(isEmptyToolData({})).toBe(true);
    expect(isEmptyToolData({ containerId: "abc" })).toBe(false);
    expect(isEmptyToolData([])).toBe(false);
  });
});

describe("tool parameters and results", () => {
  it("labels parameters in sentence case and shows no block for a call without arguments", () => {
    const { container, rerender } = render(<ToolInput input={{ containerId: "abc" }} />);
    const label = screen.getByText("Parameters");
    expect(label.className).not.toMatch(/uppercase|tracking-wide/);
    expect(screen.getByRole("button", { name: "Copy parameters" })).toBeInTheDocument();

    rerender(<ToolInput input={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows JSON as compact wrapped monospace with muted keys, on a relative fill", () => {
    const { container } = render(<ToolOutput toolName="get_settings" errorText={undefined} output={{ theme: "dark", url: "http://x" }} />);
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveTextContent('"theme": "dark"');
    for (const name of ["font-mono", "text-xs", "whitespace-pre-wrap", "wrap-anywhere"]) expect(pre.className).toContain(name);
    expect(within(pre).getByText('"theme"').className).toContain("text-muted-foreground");
    // The old CodeBlock painted bg-background (and shiki's hex) under the text
    const region = screen.getByRole("group", { name: "Result" });
    expect(region.className).toContain("bg-muted/40");
    expect(container.innerHTML).not.toMatch(/\bbg-background\b|shiki/);
  });

  it("caps a long result with its own scroller, and Show all / Show less toggles the cap", () => {
    layout({ content: 2400, box: 192 });
    render(<ToolOutput toolName="get_settings" errorText={undefined} output={longResult} />);
    const region = screen.getByRole("group", { name: "Result" });
    expect(region.className).toContain(TOOL_BLOCK_CAP.result);
    expect(region.className).toContain("overflow-y-auto");
    // A block that scrolls is reachable from the keyboard
    expect(region).toHaveAttribute("tabindex", "0");

    const showAll = screen.getByRole("button", { name: "Show all" });
    expect(showAll).toHaveAttribute("aria-expanded", "false");
    expect(showAll).toHaveAttribute("aria-controls", region.id);

    fireEvent.click(showAll);
    expect(region.className).not.toContain(TOOL_BLOCK_CAP.result);
    expect(region).not.toHaveAttribute("tabindex");
    const showLess = screen.getByRole("button", { name: "Show less" });
    expect(showLess).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(showLess);
    expect(region.className).toContain(TOOL_BLOCK_CAP.result);
    // Collapsing a long block keeps its toggle on screen
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
  });

  it("offers no toggle when the block fits", () => {
    layout({ content: 80, box: 80 });
    render(<ToolOutput toolName="get_settings" errorText={undefined} output={{ theme: "dark" }} />);
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Result" })).not.toHaveAttribute("tabindex");
  });

  it("caps parameters tighter than results", () => {
    render(<ToolInput input={longResult} />);
    expect(screen.getByRole("group", { name: "Parameters" }).className).toContain(TOOL_BLOCK_CAP.parameters);
  });

  it("caps structured results too (a long container list)", () => {
    const containers = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: `app-${i}`, status: "running" }));
    render(<ToolOutput toolName="list_containers" errorText={undefined} output={containers} />);
    const region = screen.getByRole("group", { name: "Result" });
    expect(region.className).toContain(TOOL_BLOCK_CAP.card);
    expect(within(region).getByRole("button", { name: "Open app-0 in Services" })).toBeInTheDocument();
  });

  it("shows an error on the critical tint with foreground text", () => {
    render(<ToolOutput toolName="get_settings" errorText="Sonarr refused the API key." output={undefined} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    const region = screen.getByRole("group", { name: "Error" });
    expect(region.className).toContain("bg-status-critical/12");
    expect(within(region).getByText("Sonarr refused the API key.").className).toContain("text-foreground");
  });

  it("copies the text it shows", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<ToolDataBlock label="Result" value={{ ok: true }} cap={TOOL_BLOCK_CAP.result} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('{\n  "ok": true\n}'));
    vi.unstubAllGlobals();
  });
});

describe("Show all inside a conversation", () => {
  it("releases the stick-to-bottom lock first, so the view stays where you were reading", () => {
    layout({ content: 2400, box: 192 });
    render(
      <Conversation>
        <ConversationContent>
          <ToolOutput toolName="get_settings" errorText={undefined} output={longResult} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>,
    );
    // Following the bottom: no scroll-to-bottom button
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    // The lock is released (the conversation no longer follows the bottom)
    expect(screen.getByRole("button", { name: "Scroll to bottom" })).toBeInTheDocument();
  });
});
