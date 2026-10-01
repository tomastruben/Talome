import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { contrast, over, parseColor, readTokens } from "./helpers/contrast";

const health = vi.hoisted(() => ({ status: "offline" as "online" | "offline" | "degraded" }));
vi.mock("@/hooks/use-is-online", () => ({ useIsOnline: () => ({ status: health.status }) }));

import { HEALTH_BANNER_TONE, SystemHealthBanner } from "@/components/system-health-banner";
import { SourceListItem } from "@/components/ui/source-list";

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

describe("desktop window glass", () => {
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

  const glass = { dark: material(".tm-window"), light: material(":root:not(.dark) .tm-window") };
  const content = {
    dark: tintAlpha(".tm-window-content", "--background"),
    light: tintAlpha(":root:not(.dark) .tm-window-content", "--background"),
  };
  /** The worst backdrop for each theme's text: pure white behind dark glass, pure black behind light. */
  const worstBackdrop = { dark: 1, light: 0 } as const;
  const gray = (v: number) => ({ r: v, g: v, b: v, a: 1 });
  /** Backdrop → saturate (a no-op on grey) → brightness, in sRGB as browsers apply it → card tint. */
  const glassOver = (theme: "dark" | "light", backdrop: number) =>
    over(color(themes[theme], "--card"), gray(Math.min(1, backdrop * glass[theme].brightness)), glass[theme].alpha);
  const contentOver = (theme: "dark" | "light", backdrop: number) =>
    over(color(themes[theme], "--background"), glassOver(theme, backdrop), content[theme]);

  it("is one frosted material on the window (the thick material) and never see-through", () => {
    expect(glass.dark).toMatchObject({ token: "--card", alpha: 0.85, blur: 56, saturate: 1.8, brightness: 0.7 });
    expect(glass.light).toMatchObject({ token: "--card", alpha: 0.9, blur: 56, saturate: 1.8, brightness: 1.2 });
    for (const m of Object.values(glass)) expect(m.webkitFilter).toBe(m.filter);
    expect(content).toEqual({ dark: 0.15, light: 0.25 });

    // How much of the (dimmed, blurred) wallpaper shows through: enough to read
    // as frosted glass (the owner asked for more frost on windows), not so much
    // that the window turns see-through
    for (const [name, m] of Object.entries(glass)) {
      const through = (1 - m.alpha) * Math.min(1, m.brightness);
      expect(through, name).toBeGreaterThanOrEqual(0.08);
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
