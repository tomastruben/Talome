import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { contrast, luminance, over, parseColor, readTokens, type Rgba } from "./helpers/contrast";

const health = vi.hoisted(() => ({ status: "offline" as "online" | "offline" | "degraded" }));
vi.mock("@/hooks/use-is-online", () => ({ useIsOnline: () => ({ status: health.status }) }));

import { HEALTH_BANNER_TONE, SystemHealthBanner } from "@/components/system-health-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup } from "@/components/ui/input-group";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SourceListItem, WindowSidebarSlot } from "@/components/ui/source-list";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const css = read("app/globals.css");
const light = readTokens(css, ":root");
const dark = readTokens(css, ".dark", light);
const themes = { light, dark } as const;
const color = (tokens: Record<string, string>, name: string) => parseColor(tokens[name]);

const STATUS = ["healthy", "warning", "critical", "info"] as const;
/** The terminal background used by the terminal page, sheet and ClaudeTerminal. */
const TERMINAL_BG = parseColor("#0d1117");
const TERMINAL_HEADER_BG = parseColor("#161b22");

describe("terminal surfaces stay dark in both themes", () => {
  it("dark status values read on the terminal background; the light ones do not (why the scope exists)", () => {
    for (const status of STATUS) {
      const token = `--status-${status}`;
      expect(contrast(color(dark, token), TERMINAL_BG), `dark ${token}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(dark, token), TERMINAL_HEADER_BG), `dark ${token} on header`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(light, token), TERMINAL_BG), `light ${token}`).toBeLessThan(4.5);
    }
  });

  it("puts the dark token scope on every terminal container", () => {
    expect(read("components/terminal/terminal-page.tsx")).toMatch(/className="dark absolute inset-0/);
    expect(read("components/terminal/terminal-sheet.tsx")).toMatch(/"dark fixed inset-y-0 right-0/);
    expect(read("components/terminal/claude-terminal.tsx")).toMatch(/<div className="dark flex flex-col h-full">/);
    // The status tokens the terminal uses must still be redefined by .dark.
    for (const status of STATUS) expect(dark[`--status-${status}`]).not.toEqual(light[`--status-${status}`]);
  });
});

describe("destructive pair", () => {
  const button = read("components/ui/button.tsx");
  const alpha = (re: RegExp) => Number(re.exec(button)?.[1]) / 100;
  const darkRest = alpha(/dark:bg-destructive\/(\d+)/);
  const darkHover = alpha(/dark:hover:bg-destructive\/(\d+)/);
  const lightHover = alpha(/[^:]hover:bg-destructive\/(\d+)/);

  it("keeps white button text at 4.5:1 at rest and on hover in the light theme", () => {
    const fg = color(light, "--destructive-foreground");
    const fill = color(light, "--destructive");
    expect(contrast(fg, fill)).toBeGreaterThanOrEqual(4.5);
    for (const surface of ["--background", "--card", "--surface-modal"]) {
      expect(contrast(fg, over(fill, color(light, surface), lightHover)), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never raises the tint alpha on hover in dark, so white text stays at 4.5:1 (regression: /70 was 4.26:1)", () => {
    expect(darkHover).toBeLessThanOrEqual(darkRest);
    const fg = color(dark, "--destructive-foreground");
    const fill = color(dark, "--destructive");
    for (const surface of ["--background", "--card", "--surface-modal", "--surface-popover"]) {
      for (const a of [darkRest, darkHover]) {
        expect(contrast(fg, over(fill, color(dark, surface), a)), `${surface} @${a}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("never uses the solid destructive pair without the dark tint override", () => {
    // In dark the solid pair is ~2.45:1, so any solid use must switch to the tint.
    expect(contrast(color(dark, "--destructive-foreground"), color(dark, "--destructive"))).toBeLessThan(4.5);
    for (const path of ["components/ui/button.tsx", "components/ui/badge.tsx", "components/system-health-banner.tsx"]) {
      for (const line of read(path).split("\n")) {
        if (/\bbg-destructive\b(?!\/)/.test(line) && /text-destructive-foreground/.test(line)) {
          expect(line, path).toMatch(/dark:bg-destructive\/\d+/);
        }
      }
    }
  });
});

describe("system health banner (tint recipe, never solid)", () => {
  it("renders the offline and degraded banners as tints with foreground text", () => {
    for (const status of ["offline", "degraded"] as const) {
      health.status = status;
      const { container, unmount } = render(<SystemHealthBanner />);
      const banner = container.firstElementChild as HTMLElement;
      expect(banner.className, status).toContain(HEALTH_BANNER_TONE[status].banner.split(" ")[0]);
      expect(banner.className).toContain("text-foreground");
      expect(banner.className).not.toMatch(/\bbg-destructive\b|\bbg-status-(critical|warning)(?!\/)\b|text-white|text-destructive-foreground/);
      unmount();
    }
  });

  it("keeps the title at 4.5:1 in both themes", () => {
    for (const [name, tokens] of Object.entries(themes)) {
      for (const status of ["critical", "warning"] as const) {
        const tint = over(color(tokens, `--status-${status}`), color(tokens, "--background"), 0.12);
        expect(contrast(color(tokens, "--foreground"), tint), `${name} ${status}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(tokens, `--status-${status}`), tint), `${name} ${status} icon`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("desktop-mode window controls", () => {
  it("are quiet at rest: status colours never paint window chrome (red, amber and green mean status)", () => {
    // PR #2 replaced the traffic lights with monochrome controls (window-controls.tsx).
    const controls = read("components/desktop/window-controls.tsx");
    // Close may tint critical on hover only (a destructive hint), never at rest.
    const atRest = controls.match(/(?<![\w:-])(?:bg|text|ring)-status-[\w/-]+/g) ?? [];
    expect(atRest).toEqual([]);
    expect(controls).not.toMatch(/bg-window-(close|minimize|zoom)/);
    const windowSource = read("components/desktop/desktop-window.tsx");
    expect(windowSource).toContain("<WindowControls");
    expect(windowSource).not.toMatch(/before:bg-status-/);
    expect(read("components/desktop/desktop-customization.tsx")).not.toMatch(/bg-status-critical\/70/);
  });

  it("keeps the close fill at 3:1 on the card in both themes", () => {
    for (const [name, tokens] of Object.entries(themes)) {
      expect(contrast(color(tokens, "--window-close"), color(tokens, "--card")), name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("container status dots", () => {
  it("draw stopped as a ring and failed as a fill, both at 3:1 against the surface", () => {
    for (const [name, tokens] of Object.entries(themes)) {
      for (const surface of ["--background", "--card"]) {
        const bg = color(tokens, surface);
        expect(contrast(color(tokens, "--muted-foreground"), bg), `${name} stopped ring`).toBeGreaterThanOrEqual(3);
        expect(contrast(color(tokens, "--status-critical"), bg), `${name} failed`).toBeGreaterThanOrEqual(3);
        expect(contrast(color(tokens, "--status-warning"), bg), `${name} restarting`).toBeGreaterThanOrEqual(3);
      }
    }
    // The old 40% grey fill measured ~1.8:1 on white.
    const faint = over(color(light, "--muted-foreground"), color(light, "--background"), 0.4);
    expect(contrast(faint, color(light, "--background"))).toBeLessThan(3);
  });
});

describe("critical text on an inverted surface (Files selection bar)", () => {
  it("reads at 4.5:1 on bg-foreground in both themes (regression: text-red-700 on near-black, ~3:1)", () => {
    for (const [name, tokens] of Object.entries(themes)) {
      const text = color(tokens, "--status-critical-inverse");
      expect(contrast(text, color(tokens, "--foreground")), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the selection bar uses the token, not a palette hue", () => {
    const files = read("app/dashboard/files/page.tsx");
    expect(files).toContain("text-status-critical-inverse");
    expect(files).not.toMatch(/text-red-\d|bg-red-\d|hover:bg-black\//);
  });
});

/** The declarations of the first unlayered rule whose selector is exactly `selector`. */
const ruleBody = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No ${selector} rule`);
  return match[2];
};
const material = (selector: string) => {
  const body = ruleBody(selector);
  const tint = /background:\s*color-mix\(in oklch, var\((--[\w-]+)\) (\d+)%, transparent\)/.exec(body);
  const filter = /(?<!-webkit-)backdrop-filter:\s*([^;]+);/.exec(body)?.[1].trim();
  const webkitFilter = /-webkit-backdrop-filter:\s*([^;]+);/.exec(body)?.[1].trim();
  const fn = (name: string) => Number(new RegExp(`${name}\\(([\\d.]+)(?:px)?\\)`).exec(filter ?? "")?.[1]);
  return {
    token: tint?.[1],
    alpha: Number(tint?.[2]) / 100,
    filter,
    webkitFilter,
    blur: fn("blur"),
    saturate: fn("saturate"),
    brightness: fn("brightness"),
  };
};
const tintAlpha = (selector: string, token: string) => {
  const match = new RegExp(`background:\\s*color-mix\\(in oklch, var\\(${token}\\) (\\d+)%, transparent\\)`).exec(ruleBody(selector));
  return Number(match?.[1]) / 100;
};

type Theme = "dark" | "light";
const THEMES = ["dark", "light"] as const;
const glass = { dark: material(".tm-window"), light: material(":root:not(.dark) .tm-window") };
const content = {
  dark: tintAlpha(".tm-window-content", "--background"),
  light: tintAlpha(":root:not(.dark) .tm-window-content", "--background"),
};
/** The worst backdrop for each theme's text: pure white behind dark glass, pure black behind light. */
const worstBackdrop = { dark: 1, light: 0 } as const;
const gray = (v: number) => ({ r: v, g: v, b: v, a: 1 });
/** Backdrop → saturate (a no-op on grey) → brightness, in sRGB as browsers apply it → card tint. */
const glassOver = (theme: Theme, backdrop: number) =>
  over(color(themes[theme], "--card"), gray(Math.min(1, backdrop * glass[theme].brightness)), glass[theme].alpha);
const contentOver = (theme: Theme, backdrop: number) =>
  over(color(themes[theme], "--background"), glassOver(theme, backdrop), content[theme]);

describe("desktop window glass", () => {
  it("is one frosted material on the window (the thick material) and never see-through", () => {
    expect(glass.dark).toMatchObject({ token: "--card", alpha: 0.92, blur: 56, saturate: 1.8, brightness: 0.7 });
    expect(glass.light).toMatchObject({ token: "--card", alpha: 0.94, blur: 56, saturate: 1.8, brightness: 1.2 });
    for (const m of Object.values(glass)) expect(m.webkitFilter).toBe(m.filter);
    expect(content).toEqual({ dark: 0.15, light: 0.25 });

    // How much of the (dimmed, blurred) wallpaper shows through: enough to read
    // as frosted glass, not so much that the window turns see-through (the
    // owner found 85% / 90% windows too transparent, so they are 92% / 94%)
    for (const [name, m] of Object.entries(glass)) {
      const through = (1 - m.alpha) * Math.min(1, m.brightness);
      expect(through, name).toBeGreaterThanOrEqual(0.05);
      expect(through, name).toBeLessThanOrEqual(0.2);
    }

    // The title bar and body paint nothing of their own: one glass per window
    expect(ruleBody(".tm-window-titlebar")).not.toMatch(/background|backdrop-filter/);
    expect(css).not.toMatch(/(^|\n)\.tm-window-body\s*\{/);
  });

  it("uses one material scale: thin (Dock), regular (widgets, sign-in), thick (windows)", () => {
    const scale = {
      thin: { dark: material(".tm-glass"), light: material(":root:not(.dark) .tm-glass") },
      regular: {
        dark: material("[data-desktop-widget-canvas] [data-widget]"),
        light: material(":root:not(.dark) [data-desktop-widget-canvas] [data-widget]"),
      },
      signIn: { dark: material(".tm-glass-dense"), light: material(":root:not(.dark) .tm-glass-dense") },
      thick: glass,
    };
    // The owner's scale: windows and widgets read as frosted but never see-through
    expect({
      thin: { dark: scale.thin.dark.alpha, light: scale.thin.light.alpha },
      regular: { dark: scale.regular.dark.alpha, light: scale.regular.light.alpha },
      thick: { dark: scale.thick.dark.alpha, light: scale.thick.light.alpha },
    }).toEqual({
      thin: { dark: 0.85, light: 0.88 },
      regular: { dark: 0.88, light: 0.92 },
      thick: { dark: 0.92, light: 0.94 },
    });
    for (const theme of ["dark", "light"] as const) {
      // The sign-in card is the regular material
      expect(scale.signIn[theme]).toMatchObject({
        alpha: scale.regular[theme].alpha,
        blur: scale.regular[theme].blur,
        brightness: scale.regular[theme].brightness,
      });
      // Denser and blurrier as the content gets denser
      expect(scale.thin[theme].alpha).toBeLessThan(scale.regular[theme].alpha);
      expect(scale.regular[theme].alpha).toBeLessThan(scale.thick[theme].alpha);
      expect(scale.thin[theme].blur).toBeLessThan(scale.regular[theme].blur);
      expect(scale.regular[theme].blur).toBeLessThan(scale.thick[theme].blur);
      for (const [name, m] of Object.entries(scale)) {
        const label = `${theme} ${name}`;
        expect(m[theme].token, label).toBe("--card");
        expect(m[theme].saturate, label).toBe(1.8);
        // Dark glass dims its backdrop and light glass lifts it: smoky, never foggy
        if (theme === "dark") expect(m[theme].brightness, label).toBeLessThan(1);
        else expect(m[theme].brightness, label).toBeGreaterThan(1);
        // Safari (iPad) needs the prefixed property, with the same recipe
        expect(m[theme].webkitFilter, label).toBe(m[theme].filter);
        // Over the worst backdrop, foreground text keeps AA everywhere. Regular and
        // thick glass carry muted text too, so it keeps AA there; thin glass (the
        // Dock, desktop icons) carries icons and foreground text only, and its
        // muted icons keep the 3:1 non-text minimum.
        const surface = over(
          color(themes[theme], "--card"),
          gray(Math.min(1, worstBackdrop[theme] * m[theme].brightness)),
          m[theme].alpha,
        );
        expect(contrast(color(themes[theme], "--foreground"), surface), label).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(themes[theme], "--muted-foreground"), surface), label)
          .toBeGreaterThanOrEqual(name === "thin" ? 3 : 4.5);
      }
    }
  });

  it("keeps text at AA on the glass and the content tint over any wallpaper, active or not", () => {
    for (const theme of ["dark", "light"] as const) {
      const tokens = themes[theme];
      const surfaces = {
        "title bar / sidebar": glassOver(theme, worstBackdrop[theme]),
        "content column": contentOver(theme, worstBackdrop[theme]),
      };
      for (const [surface, bg] of Object.entries(surfaces)) {
        expect(contrast(color(tokens, "--muted-foreground"), bg), `${theme} muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(tokens, "--foreground"), bg), `${theme} foreground on ${surface}`).toBeGreaterThanOrEqual(7);
      }
    }
    // Inactive windows share the material, and their title isn't faded
    expect(css).not.toMatch(/\.tm-window:not\(\[data-active\]\)/);
    expect(css).not.toMatch(/\[data-title-placement\][^{]*\{[^}]*opacity/);
  });

  it("keeps the amber needs-you count legible and distinct on window glass", () => {
    for (const theme of ["dark", "light"] as const) {
      const tokens = themes[theme];
      const fill = color(tokens, "--status-warning");
      expect(contrast(color(tokens, "--status-warning-foreground"), fill), `${theme} count text`).toBeGreaterThanOrEqual(4.5);
      for (const bg of [glassOver(theme, worstBackdrop[theme]), contentOver(theme, worstBackdrop[theme])]) {
        expect(contrast(fill, bg), `${theme} count on glass`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps sidebar labels and counts at AA on hovered and selected rows, not only on bare glass", () => {
    // The row tints and text tones, read from rendered rows so the model can't drift from the classes
    const { container } = render(
      <>
        <SourceListItem label="Selected" active trailing={12} onSelect={() => {}} />
        <SourceListItem label="Rest" trailing={12} onSelect={() => {}} />
      </>,
    );
    const [selectedRow, restRow] = Array.from(container.querySelectorAll("button"));
    const trailing = (row: Element) => row.querySelector("[data-slot='source-list-trailing']")!.className;
    const alpha = (className: string, pattern: RegExp) => {
      const match = pattern.exec(className);
      expect(match, `${pattern} in "${className}"`).not.toBeNull();
      return Number(match![1]) / 100;
    };
    const tint = {
      hover: alpha(restRow.className, /(?:^|\s)hover:bg-foreground\/(\d+)(?:\s|$)/),
      selected: alpha(selectedRow.className, /(?:^|\s)bg-foreground\/(\d+)(?:\s|$)/),
    };
    const labelAtRest = alpha(restRow.className, /(?:^|\s)text-foreground\/(\d+)(?:\s|$)/);
    const count = {
      hover: alpha(trailing(restRow), /(?:^|\s)group-hover\/source-item:text-foreground\/(\d+)(?:\s|$)/),
      selected: alpha(trailing(selectedRow), /(?:^|\s)text-foreground\/(\d+)(?:\s|$)/),
    };
    expect(trailing(restRow)).toMatch(/(?:^|\s)text-muted-foreground(?:\s|$)/);
    expect(selectedRow.className).toMatch(/(?:^|\s)text-foreground(?:\s|$)/);

    for (const theme of ["dark", "light"] as const) {
      const fg = color(themes[theme], "--foreground");
      const muted = color(themes[theme], "--muted-foreground");
      const surfaces = { glass: glassOver(theme, worstBackdrop[theme]), "content tint": contentOver(theme, worstBackdrop[theme]) };
      for (const [surface, base] of Object.entries(surfaces)) {
        const hovered = over(fg, base, tint.hover);
        const selected = over(fg, base, tint.selected);
        const cases: Record<string, number> = {
          "count at rest": contrast(muted, base),
          "count on hover": contrast(over(fg, hovered, count.hover), hovered),
          "count on selected": contrast(over(fg, selected, count.selected), selected),
          "label at rest": contrast(over(fg, base, labelAtRest), base),
          "label on hover": contrast(fg, hovered),
          "label on selected": contrast(fg, selected),
        };
        for (const [name, ratio] of Object.entries(cases)) {
          expect(ratio, `${theme} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("never writes title-bar text in a status colour (terminal Auto: amber switch fill, foreground label)", () => {
    const windowSource = read("components/desktop/desktop-window.tsx");
    expect(windowSource).not.toMatch(/text-status-/);
    expect(windowSource).not.toMatch(/(bg|ring)-status-warning\//);
    expect(windowSource).toContain("data-[state=checked]:bg-status-warning");

    const group = /className="[^"]*\bbg-muted\/(\d+)[^"]*"\s*role="group"\s*aria-label="Terminal controls"/.exec(windowSource);
    expect(group, "neutral Terminal controls group").not.toBeNull();
    for (const theme of ["dark", "light"] as const) {
      const tokens = themes[theme];
      const bg = over(color(tokens, "--muted"), glassOver(theme, worstBackdrop[theme]), Number(group![1]) / 100);
      expect(contrast(color(tokens, "--muted-foreground"), bg), `${theme} muted label`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(tokens, "--foreground"), bg), `${theme} active label`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(tokens, "--status-warning"), bg), `${theme} Auto switch fill`).toBeGreaterThanOrEqual(3);
    }
  });

  it("puts every blur material in the opaque fallback block", () => {
    const fallbackStart = css.lastIndexOf("@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {");
    const sectionStart = css.search(/\n\.tm-window\s*\{/);
    expect(sectionStart).toBeGreaterThan(0);
    expect(fallbackStart).toBeGreaterThan(sectionStart);

    const rules = (text: string) =>
      Array.from(text.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
        selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim()).filter(Boolean),
        body: m[2],
      }));
    const blurred = rules(css.slice(sectionStart, fallbackStart))
      .filter((rule) => /backdrop-filter:\s*(?!none)/.test(rule.body))
      .flatMap((rule) => rule.selectors);
    expect(blurred).toEqual(expect.arrayContaining([".tm-window", ":root:not(.dark) .tm-window", ".tm-glass", ".tm-glass-dense"]));

    const fallback = rules(css.slice(fallbackStart));
    const solid = fallback
      .filter((rule) => /backdrop-filter:\s*none/.test(rule.body) && /background:\s*var\(--surface-island-solid\)/.test(rule.body))
      .flatMap((rule) => rule.selectors);
    for (const selector of blurred) expect(solid, selector).toContain(selector);

    // The content column goes solid with it, as in classic mode
    const contentRule = fallback.find((rule) => rule.selectors.includes(".tm-window-content"));
    expect(contentRule?.selectors).toContain(":root:not(.dark) .tm-window-content");
    expect(contentRule?.body).toMatch(/background:\s*var\(--background\)/);
  });
});

describe("primitives on window glass", () => {
  // The remap block: one @media not (prefers-contrast: more) block in globals.css
  const OPEN = "@media not (prefers-contrast: more) {";
  const blockStart = css.indexOf(OPEN);
  if (blockStart < 0) throw new Error(`No "${OPEN}" block: the window remap must be off under increased contrast`);
  const blockEnd = (() => {
    let depth = 0;
    for (let i = blockStart + OPEN.length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return i;
    }
    throw new Error("The window remap block never closes");
  })();
  const block = css.slice(blockStart + OPEN.length, blockEnd);
  const normalize = (selector: string) => selector.replace(/\s+/g, " ").trim();
  const parseRules = (text: string) =>
    Array.from(text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
      selector: normalize(m[1]),
      decls: Object.fromEntries(Array.from(m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g), (d) => [d[1], d[2].trim()])) as Record<string, string>,
    }));
  const rules = parseRules(block);
  const decls = (selector: string) => {
    const rule = rules.find((r) => r.selector === normalize(selector));
    if (!rule) throw new Error(`No "${selector}" rule in the window remap`);
    return rule.decls;
  };

  const W = ":is(.tm-window-content, [data-window-sidebar])";
  const L = `:root:not(.dark) ${W}`;
  const FIELDS =
    '[data-slot="input"], [data-slot="textarea"], [data-slot="select-trigger"], [data-slot="input-group"], [data-slot="button"][data-variant="outline"]';
  const OUTLINE_TOGGLES = '[data-slot="toggle"][data-variant="outline"], [data-slot="toggle-group-item"][data-variant="outline"]';
  const CHIPS = ':is([data-slot="badge"][data-variant="outline"], kbd)';
  const REMAPPED = ["--card", "--muted", "--accent", "--secondary", "--border", "--input"] as const;

  /** What each token resolves to inside a window, per theme (light overrides the dark defaults). */
  const remap: Record<Theme, Record<string, string>> = { dark: decls(W), light: { ...decls(W), ...decls(L) } };
  const fieldEdge = { dark: decls(`${W} :is(${FIELDS})`)["--input"], light: decls(`${L} :is(${FIELDS}, ${OUTLINE_TOGGLES})`)["--input"] };
  const toggleEdge = {
    dark: decls(`${W} :is([data-slot="toggle"], [data-slot="toggle-group-item"])[data-variant="outline"]`)["--input"],
    light: fieldEdge.light,
  };
  const chipEdge = { dark: decls(`${W} ${CHIPS}`)["--border"], light: decls(`${L} ${CHIPS}`)["--border"] };
  const OUTLINE_BUTTON = '[data-slot="button"][data-variant="outline"]';
  const outlineButton = decls(`${W} ${OUTLINE_BUTTON}`);
  /** The light outline button: its own (opaque) hover fill */
  const lightOutlineButton = decls(`${L} ${OUTLINE_BUTTON}`);
  const pressedToggle = decls(`${W} :is([data-slot="toggle"], [data-slot="toggle-group-item"])[data-state="on"]`);
  /** The floating rule: found by what it does (the opaque card), so its selector can grow */
  const floatingRule = (() => {
    const found = rules.filter((r) => r.decls["--card"] === "var(--surface-popover)");
    expect(found, "one rule gives floating layers the opaque card").toHaveLength(1);
    return found[0];
  })();
  const floating = floatingRule.decls;
  /** Dark only: the select trigger's placeholder on its hover fill */
  const selectHoverText = decls(`.dark ${W} [data-slot="select-trigger"]:hover`);

  type Fill = { color: Rgba; alpha: number };
  const MIX = /^color-mix\(in oklch, var\((--[\w-]+)\) (\d+)%, (transparent|var\((--[\w-]+)\))\)$/;
  /** oklch(L 0 0): the tokens these mixes use are greys */
  const OKLCH_GREY = /^oklch\(([\d.]+) 0 0\)$/;
  /**
   * A remapped value as colour + alpha, following var() references through the
   * window's remap. A mix with transparent is a relative fill; a mix of two
   * opaque greys (in oklch, as the browser mixes them) is an opaque colour.
   */
  const fill = (theme: Theme, value: string): Fill => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (ref) return fill(theme, remap[theme][ref[1]]);
    if (value === "transparent") return { color: gray(0), alpha: 0 };
    if (value.startsWith("oklch(")) {
      const c = parseColor(value);
      return { color: { ...c, a: 1 }, alpha: c.a };
    }
    const m = MIX.exec(value);
    if (!m) throw new Error(`Not a relative fill: ${value}`);
    const share = Number(m[2]) / 100;
    if (m[3] === "transparent") return { color: color(themes[theme], m[1]), alpha: share };
    // Nothing in a window redefines the text and page tokens, so they keep their theme values
    const [a, b] = [themes[theme][m[1]], themes[theme][m[4]]].map((v) => OKLCH_GREY.exec(v)?.[1]);
    if (a === undefined || b === undefined) throw new Error(`Not a mix of two opaque greys: ${value}`);
    return { color: parseColor(`oklch(${Number(a) * share + Number(b) * (1 - share)} 0 0)`), alpha: 1 };
  };
  const paint = (f: Fill, surface: Rgba, opacity = 1) => over(f.color, surface, f.alpha * opacity);
  const token = (theme: Theme, name: string) => fill(theme, remap[theme][name]);

  // The classes the model below assumes, read from the primitives so it can't drift
  const ui = (file: string) => read(`components/ui/${file}`);
  const variant = (file: string, name: string) => {
    const match = new RegExp(`\\b${name}:\\s*\\n?\\s*"([^"]+)"`).exec(ui(file));
    expect(match, `${name} variant in ${file}`).not.toBeNull();
    return match![1];
  };
  const percent = (text: string, pattern: RegExp) => {
    const match = pattern.exec(text);
    expect(match, `${pattern}`).not.toBeNull();
    return Number(match![1]) / 100;
  };
  const fieldFill = percent(ui("input.tsx"), /\bdark:bg-input\/(\d+)/);
  const selectHoverFill = percent(ui("select.tsx"), /\bdark:hover:bg-input\/(\d+)/);
  const outline = variant("button.tsx", "outline");
  const outlineRest = percent(outline, /\bdark:bg-input\/(\d+)/);
  const outlineHover = percent(outline, /\bdark:hover:bg-input\/(\d+)/);
  /**
   * What an outline button paints over `surface`. Dark: input/30 (input/50 on
   * hover) of its own control edge. Light: bg-background, the page colour
   * (nothing in a window should redefine --background), and on hover its own --accent.
   */
  const outlineButtonFill = (theme: Theme, surface: Rgba, state: "rest" | "hover") => {
    if (theme === "dark") return paint(fill(theme, fieldEdge.dark), surface, state === "rest" ? outlineRest : outlineHover);
    const background: string | undefined = outlineButton["--background"] ?? remap[theme]["--background"];
    if (state === "rest") return paint(fill(theme, background ?? themes[theme]["--background"]), surface);
    return paint(fill(theme, lightOutlineButton["--accent"]), surface);
  };

  /** Where primitives sit in a window, at the worst backdrop for each theme's text. */
  const surfaces = (theme: Theme): Record<string, Rgba> => {
    const sidebar = glassOver(theme, worstBackdrop[theme]);
    const column = contentOver(theme, worstBackdrop[theme]);
    const card = token(theme, "--card");
    return {
      "sidebar glass": sidebar,
      "content column": column,
      "card in the content column": paint(card, column),
      "card on the sidebar": paint(card, sidebar),
      // Reduced transparency: the window turns opaque and the remap stays on
      "opaque content column": color(themes[theme], "--background"),
      "opaque sidebar": color(themes[theme], "--surface-island-solid"),
    };
  };

  it("is scoped to window surfaces and off under increased contrast; classic tokens keep their opaque values", () => {
    expect(blockStart).toBeGreaterThan(css.search(/\n\.tm-window-content\s*\{/));
    expect(rules.length).toBeGreaterThan(0);
    // Only where color-mix works: Tailwind's fallback for a mix is its first
    // colour, which would paint every fill in opaque foreground
    expect(block.trimStart().startsWith("@supports (color: color-mix(in lab, red, red)) {")).toBe(true);
    for (const rule of rules) {
      expect([W, L, `.dark ${W}`].some((scope) => rule.selector.startsWith(scope)), rule.selector).toBe(true);
    }

    // Nothing else redefines these tokens: classic mode reads :root and .dark (and
    // their increased-contrast overrides) only, so it looks exactly as before
    const outside = parseRules(css.slice(0, blockStart) + css.slice(blockEnd + 1));
    for (const rule of outside) {
      for (const name of [...REMAPPED, "--background"]) {
        if (rule.decls[name] !== undefined) expect([":root", ".dark"], `${rule.selector} sets ${name}`).toContain(rule.selector);
      }
    }
    expect(Object.fromEntries(REMAPPED.map((name) => [name, [light[name], dark[name]]]))).toEqual({
      "--card": ["oklch(1 0 0)", "oklch(0.205 0 0)"],
      "--muted": ["oklch(0.97 0 0)", "oklch(0.269 0 0)"],
      "--accent": ["oklch(0.97 0 0)", "oklch(0.269 0 0)"],
      "--secondary": ["oklch(0.97 0 0)", "oklch(0.269 0 0)"],
      "--border": ["oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"],
      "--input": ["oklch(0.922 0 0)", "oklch(1 0 0 / 15%)"],
    });

    // Inside a window every fill token is relative (a mix with transparent), never
    // an opaque grey. Text tokens keep their values, except a dark select
    // trigger's placeholder, which only lifts (on hover); --background is never
    // redefined (see the floating outline button test)
    for (const theme of THEMES) {
      for (const name of REMAPPED) expect(token(theme, name).alpha, `${theme} ${name}`).toBeLessThan(1);
    }
    for (const rule of rules) {
      for (const name of Object.keys(rule.decls)) {
        if (rule.decls === selectHoverText) expect(Object.keys(rule.decls)).toEqual(["--muted-foreground"]);
        else expect(name, rule.selector).not.toMatch(/foreground$/);
        expect(name, rule.selector).not.toBe("--background");
      }
    }
    expect(luminance(parseColor(selectHoverText["--muted-foreground"]))).toBeGreaterThan(luminance(color(dark, "--muted-foreground")));
  });

  it("keeps text at 4.5:1 on every remapped fill: chips, tracks, hovers, cards, fields and buttons", () => {
    for (const theme of THEMES) {
      const tokens = themes[theme];
      const fg = color(tokens, "--foreground");
      const muted = color(tokens, "--muted-foreground");
      for (const [where, surface] of Object.entries(surfaces(theme))) {
        const field = theme === "dark" ? paint(fill(theme, fieldEdge.dark), surface, fieldFill) : surface;
        const selectHover = theme === "dark" ? paint(fill(theme, fieldEdge.dark), surface, selectHoverFill) : surface;
        const selectHoverPlaceholder = theme === "dark" ? parseColor(selectHoverText["--muted-foreground"]) : muted;
        const buttonRest = outlineButtonFill(theme, surface, "rest");
        const buttonHover = outlineButtonFill(theme, surface, "hover");
        const track = paint(token(theme, "--muted"), surface);
        // The selected tab's thumb: dark:bg-input in dark, bg-background (opaque) in light
        const thumb = theme === "dark" ? paint(token(theme, "--input"), track) : color(tokens, "--background");
        const cases: Record<string, number> = {
          "text at rest": contrast(fg, surface),
          "muted text at rest": contrast(muted, surface),
          "chip (secondary) label": contrast(color(tokens, "--secondary-foreground"), paint(token(theme, "--secondary"), surface)),
          "neutral chip, tab track (muted)": contrast(muted, track),
          "hovered or selected row (accent)": contrast(color(tokens, "--accent-foreground"), paint(token(theme, "--accent"), surface)),
          "pressed toggle": contrast(color(tokens, "--accent-foreground"), paint(fill(theme, pressedToggle["--accent"]), surface)),
          "selected tab": contrast(fg, thumb),
          "field value": contrast(fg, field),
          "field placeholder": contrast(muted, field),
          "select placeholder on hover": contrast(selectHoverPlaceholder, selectHover),
          "outline button label": contrast(fg, buttonRest),
          "outline button label on hover": contrast(fg, buttonHover),
        };
        for (const [name, ratio] of Object.entries(cases)) {
          expect(ratio, `${theme} ${name} on ${where}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("gives every control a 3:1 edge against the surface around it", () => {
    for (const theme of THEMES) {
      const edge = fill(theme, fieldEdge[theme]);
      for (const [where, surface] of Object.entries(surfaces(theme))) {
        // A background paints under its border (border-box), so in dark the
        // field's own input/30 fill sits under the edge; light fields are clear
        const fieldUnderEdge = theme === "dark" ? paint(edge, surface, fieldFill) : surface;
        const hoverUnderEdge = theme === "dark" ? paint(edge, surface, selectHoverFill) : surface;
        // The outline button's edge: dark:border-input over its fill; in light its
        // --border, which is var(--input): its own control edge, over its opaque fill
        const buttonEdge = edge;
        const cases: Record<string, number> = {
          "field, select trigger, input group": contrast(paint(edge, fieldUnderEdge), surface),
          "select trigger on hover": contrast(paint(edge, hoverUnderEdge), surface),
          "outline button": contrast(paint(buttonEdge, outlineButtonFill(theme, surface, "rest")), surface),
          "outline button on hover": contrast(paint(buttonEdge, outlineButtonFill(theme, surface, "hover")), surface),
          "outline toggle (no fill)": contrast(paint(fill(theme, toggleEdge[theme]), surface), surface),
        };
        for (const [name, ratio] of Object.entries(cases)) {
          expect(ratio, `${theme} ${name} on ${where}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    expect(outlineButton["--border"]).toBe("var(--input)");
  });

  it("lifts chips off the glass: they stand out more than the classic chip on its page", () => {
    for (const theme of THEMES) {
      const tokens = themes[theme];
      // The owner's "2025" / "In library" chips: classic secondary on the classic page
      const classicChip = contrast(color(tokens, "--secondary"), color(tokens, "--background"));
      const hairline = token(theme, "--border");
      for (const [where, surface] of Object.entries(surfaces(theme))) {
        const chip = contrast(paint(token(theme, "--secondary"), surface), surface);
        expect(chip, `${theme} chip fill on ${where}`).toBeGreaterThanOrEqual(Math.max(1.25, classicChip));
        // Outline chips and kbd hints: a firmer edge than a hairline
        const edge = contrast(paint(fill(theme, chipEdge[theme]), surface), surface);
        expect(edge, `${theme} outline chip edge on ${where}`).toBeGreaterThanOrEqual(1.8);
        expect(edge, `${theme} outline chip edge vs hairline on ${where}`).toBeGreaterThan(contrast(paint(hairline, surface), surface));
      }
      // Chips are quieter than controls: the control edge is the strongest stroke in a window
      expect(fill(theme, chipEdge[theme]).alpha).toBeLessThan(fill(theme, fieldEdge[theme]).alpha);
    }
  });

  it("keeps surfaces floating over the content or over artwork opaque: they take the classic card", () => {
    expect(floating["--card"]).toBe("var(--surface-popover)");
    for (const theme of THEMES) {
      expect(themes[theme]["--surface-popover"], theme).toBe(themes[theme]["--card"]);
    }
  });

  it("finds floating layers by what makes them float, not by one utility class (regression: a dragged widget turned see-through)", () => {
    // dnd-kit's DragOverlay positions itself with an inline style, no class
    const dndKit = readFileSync(join(SRC, "../node_modules/@dnd-kit/core/dist/core.esm.js"), "utf8");
    expect(dndKit).toMatch(/const baseStyles = \{\s*position: 'fixed'/);

    const { container } = render(
      <div className="tm-window-content">
        <div data-case="drag overlay (inline position: fixed)" style={{ position: "fixed", touchAction: "none", top: 0, left: 0 }}>
          <div className="rounded-xl border bg-card">Dragged widget</div>
        </div>
        <div data-case="fixed panel (upload panel)" className="fixed right-4 bottom-4 rounded-xl border bg-card" />
        <a data-case="skip link (focus:fixed)" href="#main" className="sr-only focus:not-sr-only focus:fixed focus:bg-card">
          Skip to content
        </a>
        <div data-case="fixed from a breakpoint (sm:fixed)" className="relative sm:fixed bg-card" />
        <div data-case="marked floating (data-floating)" data-floating className="absolute right-4 bottom-4 bg-card" />
        <div data-case="app-card badge" className="app-card-installed-badge" />
        <div data-in-flow="card on the glass" className="rounded-xl border bg-card" />
        <div data-in-flow="absolute, not marked" className="absolute inset-0" />
        <div data-in-flow="background-attachment fixed" className="bg-fixed bg-card" />
        <div data-in-flow="table layout fixed" className="table-fixed" />
      </div>,
    );
    const floatingCases = container.querySelectorAll("[data-case]");
    const inFlowCases = container.querySelectorAll("[data-in-flow]");
    expect(floatingCases.length).toBe(6);
    expect(inFlowCases.length).toBe(4);
    for (const el of floatingCases) expect(el.matches(floatingRule.selector), el.getAttribute("data-case")!).toBe(true);
    for (const el of inFlowCases) expect(el.matches(floatingRule.selector), el.getAttribute("data-in-flow")!).toBe(false);
  });

  it("keeps a floating outline button opaque in a window (regression: the Assistant's scroll-to-bottom button lost its fill over the chat)", () => {
    // bg-background inside a window resolves to the page colour, opaque, in
    // both themes: no rule in a window redefines --background
    for (const rule of rules) expect(rule.decls["--background"], rule.selector).toBeUndefined();
    for (const theme of THEMES) expect(fill(theme, themes[theme]["--background"]).alpha, `${theme} bg-background in a window`).toBe(1);

    /** The rest fill a Button paints with `classes` on top of the outline variant, resolved inside a window. */
    const restFill = (theme: Theme, classes: string): Fill => {
      const bg = (text: string, prefix: string) =>
        new RegExp(`(?<![:\\w-])${prefix}bg-([a-z][\\w-]*)(?:/(\\d+))?(?![\\w/-])`).exec(text);
      // tailwind-merge: the caller's class replaces the variant's, per modifier
      const m = (theme === "dark" ? bg(classes, "dark:") ?? bg(outline, "dark:") : null) ?? bg(classes, "") ?? bg(outline, "");
      expect(m, `${theme} fill in "${classes}"`).not.toBeNull();
      const name = `--${m![1]}`;
      const f = fill(theme, remap[theme][name] ?? themes[theme][name]);
      return { ...f, alpha: f.alpha * (m![2] ? Number(m![2]) / 100 : 1) };
    };

    // The buttons that float over the conversation, read from their source so a
    // restyle that gives them a see-through fill fails here
    const conversation = read("components/ai-elements/conversation.tsx");
    for (const name of ["ConversationScrollButton", "ConversationDownload"]) {
      const body = new RegExp(`export const ${name} = [\\s\\S]*?\\n\\};`).exec(conversation)?.[0] ?? "";
      expect(body, name).toMatch(/<Button\b/);
      const classes = /className=\{cn\(\s*"([^"]+)"/.exec(body)?.[1] ?? "";
      expect(classes, name).toMatch(/(?<![:\w-])(absolute|fixed|sticky)\b/);
      // An island material is opaque enough by its own contract; anything else paints a token
      if (/\bmaterial-island\b/.test(classes)) continue;
      expect(body, name).toMatch(/variant="outline"/);
      for (const theme of THEMES) expect(restFill(theme, classes).alpha, `${theme} ${name} fill in a window`).toBe(1);
    }
    // ...and the model itself: a translucent fill on a floating button fails it
    expect(restFill("dark", "absolute dark:bg-muted").alpha).toBeLessThan(1);
    expect(restFill("dark", "absolute").alpha).toBeLessThan(1);
    expect(restFill("light", "absolute bg-card").alpha).toBeLessThan(1);
  });

  it("keeps the outline button's label legible over a surface the app paints itself (the player's black), at rest and on hover", () => {
    const black = gray(0);
    for (const theme of THEMES) {
      const fg = color(themes[theme], "--foreground");
      for (const state of ["rest", "hover"] as const) {
        expect(contrast(fg, outlineButtonFill(theme, black, state)), `${theme} outline button label on black, ${state}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Light: opaque at rest and on hover, so nothing under the button shows through
    expect(fill("light", lightOutlineButton["--accent"]).alpha).toBe(1);
  });

  it("reaches the sidebar slot and finds each control by its slot and variant", () => {
    const { container } = render(
      <>
        <WindowSidebarSlot />
        <Badge variant="secondary">2025</Badge>
        <Badge variant="outline">Pending</Badge>
        <Button variant="outline">Refresh</Button>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
        <InputGroup />
        <Select>
          <SelectTrigger aria-label="Sort">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
        </Select>
        <Toggle variant="outline" aria-label="Bold" />
        <ToggleGroup type="single" variant="outline" value="folder" aria-label="Where to search">
          <ToggleGroupItem value="folder">This folder</ToggleGroupItem>
          <ToggleGroupItem value="deep">Include subfolders</ToggleGroupItem>
        </ToggleGroup>
      </>,
    );
    expect(container.querySelector("[data-window-sidebar]")).not.toBeNull();
    for (const selector of [
      '[data-slot="badge"][data-variant="secondary"]',
      '[data-slot="badge"][data-variant="outline"]',
      '[data-slot="button"][data-variant="outline"]',
      '[data-slot="input"]',
      '[data-slot="textarea"]',
      '[data-slot="input-group"]',
      '[data-slot="select-trigger"]',
      '[data-slot="toggle"][data-variant="outline"]',
      '[data-slot="toggle-group-item"][data-variant="outline"][data-state="on"]',
    ]) {
      expect(container.querySelector(selector), selector).not.toBeNull();
    }

    // The classes the model assumes
    for (const file of ["input.tsx", "textarea.tsx", "select.tsx", "input-group.tsx"]) {
      expect(ui(file), file).toMatch(/\bborder-input\b/);
      expect(percent(ui(file), /\bdark:bg-input\/(\d+)/), file).toBe(fieldFill);
    }
    for (const file of ["input.tsx", "textarea.tsx", "select.tsx"]) expect(ui(file), file).toMatch(/(?<![:\w-])bg-transparent\b/);
    const inputGroup = /data-slot="input-group"[\s\S]*?cn\(\s*"([^"]+)"/.exec(ui("input-group.tsx"))?.[1] ?? "";
    expect(inputGroup).toMatch(/\bborder-input\b/);
    expect(inputGroup).not.toMatch(/(?<![:\w-])bg-/);
    expect(ui("select.tsx")).toMatch(/data-\[placeholder\]:text-muted-foreground/);
    expect(outline).toMatch(/(?<![:\w-])bg-background\b/);
    expect(outline).toMatch(/\bdark:border-input\b/);
    expect(outline).toMatch(/(?<![:\w-])hover:bg-accent\b/);
    expect(variant("toggle.tsx", "outline")).toMatch(/\bborder-input bg-transparent\b/);
    expect(ui("toggle.tsx")).toMatch(/data-\[state=on\]:bg-accent data-\[state=on\]:text-accent-foreground/);
    expect(variant("badge.tsx", "secondary")).toMatch(/^bg-secondary text-secondary-foreground\b/);
    expect(variant("badge.tsx", "outline")).toMatch(/^border-border text-foreground\b/);
    expect(variant("badge.tsx", "neutral")).toBe("bg-muted text-muted-foreground");
    expect(ui("skeleton.tsx")).toMatch(/"bg-accent /);
    expect(ui("card.tsx")).toMatch(/\bbg-card py-6 text-card-foreground\b/);
    expect(ui("tabs.tsx")).toMatch(/rounded-lg bg-muted p-0\.5 text-muted-foreground/);
    expect(ui("tabs.tsx")).toMatch(/bg-background shadow-sm\/5 dark:bg-input"/);
  });
});
