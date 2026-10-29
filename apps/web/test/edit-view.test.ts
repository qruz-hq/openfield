// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { Point } from "../src/detail/edit/mask";
import {
  type Box,
  fitZoom,
  imageRect,
  imageToScreen,
  screenScale,
  screenToImage,
  type Viewport,
} from "../src/detail/edit/view";

// Pointer to image pixel and back, the way Media lays the image out: fit and letterbox, then zoom and
// pan about the box's centre.

const box: Box = { left: 140, top: 60, width: 1000, height: 500 };
const image = { width: 3840, height: 2160 };

const viewport = (zoom: number | null, x = 0, y = 0): Viewport => ({ box, image, zoom, x, y });

const close = (a: Point, b: Point) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe("fit", () => {
  test("fits the whole image and letterboxes the long sides", () => {
    const zoom = fitZoom(box, image);
    expect(zoom).toBeCloseTo(500 / 2160, 10);
    const rect = imageRect(viewport(null))!;
    expect(rect.height).toBeCloseTo(500, 6);
    expect(rect.top).toBeCloseTo(60, 6);
    // Bars left and right, the same width each.
    const bar = (1000 - 3840 * zoom) / 2;
    expect(bar).toBeGreaterThan(50);
    expect(rect.left).toBeCloseTo(140 + bar, 6);
    expect(rect.left + rect.width).toBeCloseTo(140 + 1000 - bar, 6);
  });

  test("never upscales a small image (§4.0)", () => {
    expect(fitZoom(box, { width: 400, height: 300 })).toBe(1);
    const rect = imageRect({ box, image: { width: 400, height: 300 }, zoom: null, x: 0, y: 0 })!;
    expect(rect).toEqual({ left: 140 + 300, top: 60 + 100, width: 400, height: 300 });
  });

  test("has no layout until the box has a size", () => {
    expect(fitZoom({ width: 0, height: 500 }, image)).toBe(0);
    expect(imageRect({ ...viewport(null), box: { ...box, width: 0 } })).toBeNull();
  });

  test("a point in the letterbox lands off the image", () => {
    const rect = imageRect(viewport(null))!;
    const p = screenToImage(rect, image, { x: box.left + 10, y: box.top + 250 });
    expect(p.x).toBeLessThan(0);
    expect(p.y).toBeCloseTo(1080, 6);
  });
});

describe("mapping", () => {
  const zooms = [null, 0.05, 0.3, 1, 2.75, 16];
  const pans = [
    [0, 0],
    [120, -80],
    [-2400, 900],
  ] as const;

  test("screen to image and back is a round trip at every zoom and pan", () => {
    for (const zoom of zooms) {
      for (const [x, y] of pans) {
        const rect = imageRect(viewport(zoom, x, y))!;
        for (const screen of [
          { x: 140, y: 60 },
          { x: 640.25, y: 310.75 },
          { x: 1139, y: 559 },
          { x: -50, y: 900 },
        ]) {
          close(imageToScreen(rect, image, screenToImage(rect, image, screen)), screen);
        }
        for (const pixel of [
          { x: 0, y: 0 },
          { x: 1920.5, y: 1080.5 },
          { x: 3840, y: 2160 },
          { x: 12.25, y: 2001.75 },
        ]) {
          close(screenToImage(rect, image, imageToScreen(rect, image, pixel)), pixel);
        }
      }
    }
  });

  test("the box's centre is the image's centre plus the pan, at any zoom", () => {
    for (const zoom of zooms) {
      for (const [x, y] of pans) {
        const rect = imageRect(viewport(zoom, x, y))!;
        const at = screenToImage(rect, image, { x: box.left + 500 + x, y: box.top + 250 + y });
        close(at, { x: 1920, y: 1080 });
        expect(screenScale(rect, image)).toBeCloseTo(zoom ?? fitZoom(box, image), 10);
      }
    }
  });

  test("one screen pixel is 1 / zoom image pixels", () => {
    const rect = imageRect(viewport(4, 30, 10))!;
    const a = screenToImage(rect, image, { x: 600, y: 300 });
    const b = screenToImage(rect, image, { x: 601, y: 302 });
    expect(b.x - a.x).toBeCloseTo(0.25, 10);
    expect(b.y - a.y).toBeCloseTo(0.5, 10);
  });

  test("matches Media's transform: fit-size box, centred, then translate and scale about its centre", () => {
    for (const zoom of zooms) {
      for (const [x, y] of pans) {
        const fit = fitZoom(box, image);
        const scale = (zoom ?? fit) / fit;
        const fitW = image.width * fit;
        const fitH = image.height * fit;
        // translate(-50%, -50%) from the box centre, translate(x, y), then scale around the middle.
        const midX = box.left + box.width / 2 + x;
        const midY = box.top + box.height / 2 + y;
        const expected = {
          left: midX - (fitW * scale) / 2,
          top: midY - (fitH * scale) / 2,
          width: fitW * scale,
          height: fitH * scale,
        };
        const rect = imageRect(viewport(zoom, x, y))!;
        expect(rect.left).toBeCloseTo(expected.left, 6);
        expect(rect.top).toBeCloseTo(expected.top, 6);
        expect(rect.width).toBeCloseTo(expected.width, 6);
        expect(rect.height).toBeCloseTo(expected.height, 6);
      }
    }
  });

  test("works from the element's own measured rectangle too", () => {
    const measured: Box = { left: 200, top: 100, width: 960, height: 540 };
    close(screenToImage(measured, image, { x: 200, y: 100 }), { x: 0, y: 0 });
    close(screenToImage(measured, image, { x: 1160, y: 640 }), { x: 3840, y: 2160 });
    close(screenToImage(measured, image, { x: 680, y: 370 }), { x: 1920, y: 1080 });
  });
});
