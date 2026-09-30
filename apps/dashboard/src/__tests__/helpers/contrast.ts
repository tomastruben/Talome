/**
 * WCAG contrast for the colour notations used in globals.css (oklch and hex),
 * with alpha compositing. Test-only: the design tokens are CSS, so contrast
 * rules are asserted by parsing the stylesheet rather than by rendering.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function linearToSrgb(x: number): number {
  const v = clamp01(x);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Parses `oklch(L C H)` / `oklch(L C H / A%)` or `#rrggbb` into sRGB 0-1. */
export function parseColor(input: string): Rgba {
  const value = input.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (!m) throw new Error(`Unsupported colour: ${input}`);
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const H = (Number(m[4]) * Math.PI) / 180;
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const mm = m_ ** 3;
  const s = s_ ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    a: alpha,
  };
}

/** Paints `top` at `opacity` (times its own alpha) over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba, opacity = 1): Rgba {
  const a = top.a * opacity;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

export function luminance(c: Rgba): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

export function contrast(fg: Rgba, bg: Rgba): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Reads the custom properties of the first rule whose selector is exactly
 * `selector` (e.g. ":root" or ".dark") and resolves var() references against
 * that block, falling back to `fallback` (the :root block).
 */
export function readTokens(css: string, selector: string, fallback?: Record<string, string>): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = new RegExp(`(^|\\n)${escaped}\\s*\\{`).exec(css);
  if (!start) throw new Error(`No ${selector} block`);
  const open = start.index + start[0].length;
  let depth = 1;
  let i = open;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  const body = css.slice(open, i - 1);
  const raw: Record<string, string> = { ...(fallback ?? {}) };
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
  const resolve = (v: string, seen = 0): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (!ref || seen > 10) return v;
    const next = raw[ref[1]];
    // Defined elsewhere (fonts, Next.js variables): leave it as written.
    if (next === undefined) return v;
    return resolve(next, seen + 1);
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = resolve(v);
  return out;
}
