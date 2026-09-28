// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { CardMediaView } from "../src/nodes/generate/card-size";
import {
  gridShape,
  takesOf,
  variationsBox,
  variationsLayout,
  variationsRestBox,
  variationsRestKey,
} from "../src/nodes/variations/card-size";
import { variationsSpec } from "../src/nodes/variations/spec";
import { ctx } from "./fixtures";

// The Variations card is its images (design njYDO): 320 wide, as tall as its grid at the images'
// shape, between 180 and 480.

const NO_MEDIA: CardMediaView = { dims: {}, shown: {} };
const params = (raw: Record<string, unknown>) => variationsSpec.parseParams(raw, ctx);

describe("the Variations card's size", () => {
  test("one image fills it, two sit side by side, more sit in two rows", () => {
    expect(gridShape(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridShape(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridShape(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(8)).toEqual({ cols: 2, rows: 2 });
  });

  test("four square takes make a square card; wide takes a shorter one, never under 180", () => {
    expect(variationsBox(4, 1)).toEqual({ w: 320, h: 320 });
    // Two rows of 159-wide 16:9 cells: 2 × 89.44 + 2.
    expect(variationsBox(4, 16 / 9)).toEqual({ w: 320, h: 180.88 });
    expect(variationsBox(2, 16 / 9)).toEqual({ w: 320, h: 180 });
    // Tall takes stop at 480.
    expect(variationsBox(4, 9 / 16)).toEqual({ w: 320, h: 480 });
  });

  test("what one run makes: the takes, the prompt lines or the models", () => {
    expect(takesOf(params({ strategy: "same-prompt", count: 6 }))).toBe(6);
    expect(takesOf(params({ strategy: "prompt-list", prompts: ["a", "", "b", "c"] }))).toBe(3);
    expect(
      takesOf(params({ strategy: "model-list", models: ["google:banana", "google:banana", "google:pro"] })),
    ).toBe(2);
  });

  test("before it has images it follows the chosen ratio and what one run makes", () => {
    const frame = { id: "v" };
    const wide = variationsLayout({
      frame,
      params: { strategy: "same-prompt", count: 4, size: { kind: "aspect", ratio: "16:9" } },
      result: null,
      ctx,
      media: NO_MEDIA,
    });
    expect(wide).toEqual({ w: 320, h: 180.88, count: 4, exact: true });
  });

  test("with images it follows the first one's shape, and waits on the saved box until it's known", () => {
    const frame = { id: "v", size: { w: 320, h: 300 } };
    const result = { assetIds: ["a", "b", "c", "d"] };
    const input = { frame, params: { count: 4 }, result, ctx };
    // Not known yet: the saved box stands in, and nothing is saved over it.
    expect(variationsLayout({ ...input, media: NO_MEDIA })).toEqual({
      w: 320,
      h: 300,
      count: 4,
      exact: false,
    });
    expect(variationsRestBox(input, NO_MEDIA)).toBeNull();
    // A thumbnail's rounded size draws it but isn't saved.
    const approx: CardMediaView = { dims: { a: { w: 1600, h: 900, approx: true } }, shown: {} };
    expect(variationsLayout({ ...input, media: approx }).exact).toBe(false);
    // The image's own size: drawn and saved.
    const exact: CardMediaView = { dims: { a: { w: 1600, h: 900 } }, shown: {} };
    expect(variationsLayout({ ...input, media: exact })).toEqual({
      w: 320,
      h: 180.88,
      count: 4,
      exact: true,
    });
    expect(variationsRestBox(input, exact)).toEqual({ w: 320, h: 180.88 });
  });

  test("the saved box moves when its images or what it makes change, not otherwise", () => {
    const shape = variationsRestKey({ count: 4 }, null);
    expect(variationsRestKey({ count: 4 }, null)).toBe(shape);
    expect(variationsRestKey({ count: 2 }, null)).not.toBe(shape);
    expect(variationsRestKey({ count: 4 }, { assetIds: ["a", "b"] })).toBe("images:a:2");
  });
});
