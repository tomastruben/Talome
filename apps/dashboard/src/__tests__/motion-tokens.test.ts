import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAG_SETTLE_SPRING,
  DURATION,
  DURATION_MS,
  EASE_ENTER,
  EASE_EXIT,
  TRAVEL,
  dampingRatio,
  enter,
  exit,
} from "@/lib/motion";

const SRC = join(__dirname, "..");
const DASHBOARD = join(SRC, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(path, out);
    } else if (/\.(tsx?|css)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const sources = walk(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("lib/motion tokens", () => {
  it("keeps every entrance within the 200ms ceiling and exits faster than entrances", () => {
    expect(DURATION.base).toBeLessThanOrEqual(0.2);
    expect(DURATION.sheet).toBeLessThanOrEqual(0.2);
    expect(DURATION.exit).toBeLessThan(DURATION.base);
    expect(DURATION.exitFast).toBeLessThan(DURATION.exit);
    for (const key of Object.keys(DURATION) as Array<keyof typeof DURATION>) {
      expect(DURATION_MS[key]).toBe(Math.round(DURATION[key] * 1000));
    }
  });

  it("finishes opacity before transform on entrances", () => {
    const t = enter();
    expect(t.opacity?.duration).toBeCloseTo(DURATION.base * 0.6, 3);
    expect(t.ease).toEqual(EASE_ENTER);
    expect(exit().ease).toEqual(EASE_EXIT);
  });

  it("uses short travel only", () => {
    for (const value of Object.values(TRAVEL)) expect(Math.abs(value)).toBeLessThanOrEqual(24);
  });

  it("has no spring that overshoots", () => {
    expect(dampingRatio(DRAG_SETTLE_SPRING)).toBeGreaterThanOrEqual(1);
  });

  it("is mirrored in globals.css, with --ease-default no longer CSS `ease`", () => {
    const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
    expect(css).toContain("--ease-enter: cubic-bezier(0.22, 1, 0.36, 1);");
    expect(css).toContain("--ease-exit: cubic-bezier(0.4, 0, 1, 1);");
    expect(css).toContain("--ease-default: var(--ease-enter);");
    expect(css).not.toContain("cubic-bezier(0.25, 0.1, 0.25, 1)");
    expect(css).toMatch(/--duration-base:\s*180ms/);
  });
});

describe("one motion package", () => {
  it("never imports framer-motion (use motion/react)", () => {
    const offenders = sources.filter((s) => /from\s+["']framer-motion["']/.test(s.text)).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it("does not list framer-motion as a direct dependency", () => {
    const pkg = JSON.parse(readFileSync(join(DASHBOARD, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["framer-motion"]).toBeUndefined();
    expect(pkg.dependencies?.motion).toBeDefined();
  });

  it("has no literal CSS `ease` curve left in motion props", () => {
    const offenders = sources
      .filter((s) => /\[0\.25,\s*0\.1,\s*0\.25,\s*1\]|cubic-bezier\(0\.25,0\.1,0\.25,1\)/.test(s.text))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });
});

describe("accessibility baseline (P0-1)", () => {
  it("writes every ping, pulse, bounce and spin loop with motion-safe:", () => {
    const bare = /(?<![\w:[-])animate-(ping|pulse|bounce|spin)\b/;
    const offenders = sources
      .filter((s) => !s.path.endsWith(".css") && bare.test(s.text))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it("stops every CSS loop, spin included, in the reduced-motion safety net", () => {
    const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
    const net = css.slice(css.indexOf("Reduced motion safety net"));
    const block = /\.animate-ping,[\s\S]*?\{\s*animation: none !important;/.exec(net)?.[0] ?? "";
    for (const loop of ["ping", "pulse", "bounce", "spin", "breathe", "thinking-dot"]) {
      expect(block, loop).toContain(`.animate-${loop}`);
    }
  });

  it("holds motion/react keyframe loops still under reduced motion", () => {
    // MotionConfig reducedMotion="user" drops transforms but not opacity loops.
    const offenders = sources
      .filter((s) => /repeat:\s*Infinity/.test(s.text) && !/useReducedMotion\(\)/.test(s.text))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it("lets the edge-fade transition win: no transition utility on a fading viewport", () => {
    const scrollArea = readFileSync(join(SRC, "components/ui/scroll-area.tsx"), "utf8");
    expect(scrollArea).toMatch(/fadeEdges \? "edge-fade" : "transition-\[color,box-shadow\]"/);
    const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
    expect(css).toMatch(/\.edge-fade \{\s*transition: color var\(--duration-fast\)[^;]*--edge-fade-top var\(--duration-press\)/);
  });

  it("never disables pinch zoom", () => {
    const layout = readFileSync(join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/maximumScale\s*:/);
    expect(layout).not.toMatch(/user-scalable\s*=\s*no/);
  });

  it("honours reduced motion at the root, the dashboard shell and the desktop shell", () => {
    const provider = readFileSync(join(SRC, "components/motion-provider.tsx"), "utf8");
    expect(provider).toContain('<MotionConfig reducedMotion="user">');
    for (const file of ["app/layout.tsx", "app/dashboard/layout.tsx", "app/dashboard/desktop/page.tsx"]) {
      expect(readFileSync(join(SRC, file), "utf8"), file).toContain("<MotionProvider>");
    }
  });

  it("keeps design-system primitives free of banned motion", () => {
    const owned = sources.filter(
      (s) =>
        s.path.startsWith("components/ui/") ||
        s.path === "components/layout/stack-layout.tsx" ||
        s.path === "components/dashboard/stat-card.tsx" ||
        s.path === "lib/motion.ts",
    );
    // components/ui/sidebar.tsx and chart.tsx are vendored shadcn; migrate later.
    const vendored = new Set(["components/ui/sidebar.tsx", "components/ui/chart.tsx", "components/ui/stack-setup.tsx"]);
    const banned = [
      /\btransition-all\b/,
      /\bease-in-out\b/,
      /\bduration-(?!100\b|120\b|140\b|150\b|180\b|200\b)\d+\b/,
      /\banimate-ping\b/,
      /useSpring\b/,
      /bg-black\/\d+/,
      /#34C759/i,
    ];
    const offenders = owned
      .filter((s) => !vendored.has(s.path))
      .flatMap((s) => banned.filter((re) => re.test(s.text)).map((re) => `${s.path}: ${re}`));
    expect(offenders).toEqual([]);
  });
});
