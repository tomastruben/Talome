import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { contrast, over, parseColor, readTokens } from "./helpers/contrast";

const health = vi.hoisted(() => ({ status: "offline" as "online" | "offline" | "degraded" }));
vi.mock("@/hooks/use-is-online", () => ({ useIsOnline: () => ({ status: health.status }) }));

import { HEALTH_BANNER_TONE, SystemHealthBanner } from "@/components/system-health-banner";

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

describe("desktop-mode traffic lights", () => {
  it("fill with the --window-* chrome tokens and the light-mode edge, never the status tokens", () => {
    const source = read("components/desktop/desktop-window.tsx");
    for (const token of ["close", "minimize", "zoom"]) {
      expect(source).toContain(`"before:bg-window-${token} before:ring-1 before:ring-inset before:ring-window-control-edge"`);
    }
    expect(source).not.toMatch(/before:bg-status-/);
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
