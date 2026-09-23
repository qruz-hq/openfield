// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";

// WCAG 2.2 contrast gate over the token pairs the UI actually draws (PRD §2.11). If a pair fails,
// move the token in src/styles.css; don't loosen the threshold.

type Theme = "light" | "dark";
type Rgba = [number, number, number, number];

const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

function rootBlock(source: string): string {
  const start = source.indexOf(":root {");
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i);
  }
  throw new Error("No :root block in styles.css");
}

const raw = new Map<string, string>();
for (const [, name, value] of rootBlock(css).matchAll(/--of-([a-z0-9-]+):\s*([^;]+);/g)) {
  raw.set(name!, value!.trim());
}

function token(name: string, theme: Theme): string {
  const value = raw.get(name);
  if (!value) throw new Error(`Unknown token --of-${name}`);
  const alias = value.match(/^var\(--of-([a-z0-9-]+)\)$/);
  if (alias) return token(alias[1]!, theme);
  const pair = value.match(/^light-dark\(\s*(#[0-9a-f]+)\s*,\s*(#[0-9a-f]+)\s*\)$/i);
  if (pair) return theme === "light" ? pair[1]! : pair[2]!;
  if (/^#[0-9a-f]+$/i.test(value)) return value;
  throw new Error(`--of-${name} is not a color: ${value}`);
}

function parse(color: string): Rgba {
  const hex = color.slice(1);
  const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast of `fg` drawn over `layers`, listed top to bottom. Plain hex values are photos. */
function contrast(theme: Theme, fg: string, layers: string[]): number {
  const resolve = (c: string) => parse(c.startsWith("#") ? c : token(c, theme));
  let bg = resolve(layers[layers.length - 1]!);
  for (let i = layers.length - 2; i >= 0; i--) bg = over(resolve(layers[i]!), bg);
  const a = luminance(over(resolve(fg), bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const BODY = 4.5;
const UI = 3;
const SURFACES = ["surface", "canvas", "elevated", "elevated-2"];
const WHITE_PHOTO = "#FFFFFF";
const BLACK_PHOTO = "#000000";

interface Pair {
  fg: string;
  on: string[];
  min: number;
  where: string;
}

const pairs: Pair[] = [
  ...["text-primary", "text-secondary", "text-tertiary"].flatMap((fg) =>
    SURFACES.map((bg) => ({ fg, on: [bg], min: BODY, where: `${fg} text on ${bg}` })),
  ),
  { fg: "accent", on: ["surface"], min: BODY, where: "link and Try again on the page" },
  { fg: "accent", on: ["elevated"], min: BODY, where: "link in a card or popover" },
  ...["surface", "elevated", "elevated-2"].map((bg) => ({
    fg: "accent",
    on: ["accent-soft", bg],
    min: BODY,
    where: `active nav or tab on ${bg}`,
  })),
  { fg: "text-primary", on: ["accent-soft", "elevated"], min: BODY, where: "selected option row" },
  { fg: "accent-fg", on: ["accent"], min: BODY, where: "primary button label" },
  { fg: "accent-fg", on: ["accent-hover"], min: BODY, where: "primary button label on hover" },
  { fg: "danger", on: ["surface"], min: BODY, where: "danger text on the page" },
  { fg: "danger", on: ["elevated"], min: BODY, where: "Delete in a menu" },
  { fg: "danger", on: ["danger-soft", "surface"], min: BODY, where: "error pill or badge on the page" },
  { fg: "danger", on: ["danger-soft", "elevated"], min: BODY, where: "error pill or badge in a card" },
  { fg: "text-primary", on: ["danger-soft", "surface"], min: BODY, where: "error banner message" },
  { fg: "text-primary", on: ["danger-soft", "elevated"], min: BODY, where: "failed tile reason" },
  { fg: "danger-fg", on: ["danger"], min: BODY, where: "danger button label" },
  { fg: "overlay-fg", on: ["overlay", WHITE_PHOTO], min: BODY, where: "overlay button on a white photo" },
  { fg: "overlay-fg", on: ["overlay", BLACK_PHOTO], min: BODY, where: "overlay button on a black photo" },
  {
    fg: "overlay-fg",
    on: ["overlay-scrim", WHITE_PHOTO],
    min: BODY,
    where: "tile hover caption on a white photo",
  },
  { fg: "overlay-fg", on: ["status-fill", "elevated"], min: BODY, where: "tile status pill label" },
  { fg: "overlay-fg-muted", on: ["status-fill", "elevated"], min: UI, where: "tile status pill icon" },
  ...SURFACES.map((bg) => ({
    fg: "accent",
    on: [bg],
    min: UI,
    where: `focus ring and selected fill on ${bg}`,
  })),
  ...["surface", "elevated", "elevated-2"].map((bg) => ({
    fg: "control-line",
    on: [bg],
    min: UI,
    where: `unchecked checkbox edge on ${bg}`,
  })),
  { fg: "danger", on: ["surface"], min: UI, where: "invalid field ring" },
];

describe("contrast", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} theme meets WCAG 2.2 AA`, () => {
      const failures = pairs
        .map((p) => ({ ...p, ratio: contrast(theme, p.fg, p.on) }))
        .filter((p) => p.ratio < p.min)
        .map((p) => `${p.where}: ${p.ratio.toFixed(2)}:1, needs ${p.min}:1`);
      expect(failures).toEqual([]);
    });
  }
});

// Not a WCAG rule: a selected fill only has to be told apart from its track. Dark sits at about
// 1.2:1 by design; light must not be fainter.
describe("selected states read in both themes", () => {
  const SELECTED = 1.15;
  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: picked segment and active rail item`, () => {
      // The picked segment's fill, or in light its edge, against the track.
      const fill = contrast(theme, "segment-on", ["surface"]);
      const edge = contrast(theme, "surface", ["segment-on-line", "segment-on"]);
      expect(Math.max(fill, edge)).toBeGreaterThanOrEqual(SELECTED);
      expect(contrast(theme, "surface", ["accent-soft", "surface"])).toBeGreaterThanOrEqual(SELECTED);
    });
  }
});

describe("tokens", () => {
  const required = [
    "surface",
    "canvas",
    "elevated",
    "elevated-2",
    "border",
    "border-strong",
    "text-primary",
    "text-secondary",
    "text-tertiary",
    "accent",
    "accent-fg",
    "accent-soft",
    "accent-line",
    "danger",
    "danger-soft",
    "danger-line",
    "scrim",
    "grid-dot",
    "surface-0",
    "surface-sheet",
    "on-accent",
  ];

  test("every design token resolves in both themes", () => {
    for (const name of required) {
      expect(token(name, "dark")).toMatch(/^#[0-9a-f]{6,8}$/i);
      expect(token(name, "light")).toMatch(/^#[0-9a-f]{6,8}$/i);
    }
  });

  test("dark surfaces match design.pen", () => {
    const design: Record<string, string> = {
      surface: "#0e1012",
      canvas: "#0b0d0e",
      elevated: "#17191c",
      "elevated-2": "#202327",
      border: "#ffffff14",
      "border-strong": "#ffffff29",
      "text-primary": "#f5f6f7",
      "text-secondary": "#f5f6f79e",
      accent: "#e9e3d8",
      "accent-fg": "#14161a",
      "accent-soft": "#e9e3d814",
      "accent-line": "#e9e3d840",
      scrim: "#0000008c",
      "grid-dot": "#ffffff0f",
    };
    for (const [name, value] of Object.entries(design)) expect(token(name, "dark").toLowerCase()).toBe(value);
  });
});
