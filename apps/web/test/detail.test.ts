// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { downloadName, frozenSettings, inTrashCaption, relativeTime, thumbAt } from "../src/detail/format";
import { afterLeaving, navFor, resolvePending, stepNext, stepPrevious } from "../src/detail/stepping";
import { asset, at } from "./fixtures";

const list = [asset(at(40)), asset(at(30)), asset(at(20)), asset(at(10))];
const [a, b, c, d] = list as [(typeof list)[0], (typeof list)[0], (typeof list)[0], (typeof list)[0]];

describe("navFor", () => {
  test("steps through the loaded list in its order", () => {
    const nav = navFor(list, b.id, false);
    expect(nav.index).toBe(1);
    expect(nav.previous?.id).toBe(a.id);
    expect(nav.next?.id).toBe(c.id);
    expect(nav.nextUnloaded).toBe(false);
  });

  test("no Previous on the first image, no Next on the last when nothing more loads", () => {
    expect(navFor(list, a.id, false).previous).toBeNull();
    const last = navFor(list, d.id, false);
    expect(last.next).toBeNull();
    expect(last.nextUnloaded).toBe(false);
  });

  test("Next on the last loaded image waits for the next page", () => {
    const nav = navFor(list, d.id, true);
    expect(nav.next).toBeNull();
    expect(nav.nextUnloaded).toBe(true);
    expect(stepNext(nav, d.id)).toEqual({
      kind: "pending",
      step: { index: 4, skip: d.id, otherwise: "stay" },
    });
  });

  test("an image that left the list while open steps from where it was", () => {
    const without = [a, c, d];
    const nav = navFor(without, b.id, false, 1);
    expect(nav.index).toBe(-1);
    expect(nav.previous?.id).toBe(a.id);
    expect(nav.next?.id).toBe(c.id);
  });

  test("an image no page holds uses the server's neighbours", () => {
    const nav = navFor(list, "01K6BQ80000000000000000ZZZ", true, -1, { previous: c, next: null });
    expect(nav.previous?.id).toBe(c.id);
    expect(nav.next).toBeNull();
    expect(nav.nextUnloaded).toBe(false);
    expect(stepNext(nav, "x")).toEqual({ kind: "none" });
    expect(stepPrevious(nav)).toEqual({ kind: "show", id: c.id });
  });
});

describe("afterLeaving", () => {
  test("shows the next image", () => {
    expect(afterLeaving(navFor(list, b.id, false), b.id)).toEqual({ kind: "show", id: c.id });
  });

  test("shows the previous one after the last", () => {
    expect(afterLeaving(navFor(list, d.id, false), d.id)).toEqual({ kind: "show", id: c.id });
  });

  test("closes when it was the only one", () => {
    expect(afterLeaving(navFor([a], a.id, false), a.id)).toEqual({ kind: "close" });
  });

  test("waits for the next page when it was the last loaded", () => {
    expect(afterLeaving(navFor(list, d.id, true), d.id)).toEqual({
      kind: "pending",
      step: { index: 3, skip: d.id, otherwise: c.id },
    });
  });
});

describe("resolvePending", () => {
  const step = { index: 3, skip: d.id, otherwise: c.id };

  test("waits while the image being left is still there", () => {
    expect(resolvePending(list, step, true, false)).toEqual({ kind: "wait" });
  });

  test("loads the next page once it's gone", () => {
    expect(resolvePending([a, b, c], step, true, false)).toEqual({ kind: "load" });
    expect(resolvePending([a, b, c], step, true, true)).toEqual({ kind: "wait" });
  });

  test("shows what took its place", () => {
    const e = asset(at(5));
    expect(resolvePending([a, b, c, e], step, false, false)).toEqual({ kind: "show", id: e.id });
  });

  test("falls back when the list ends first", () => {
    expect(resolvePending([a, b, c], step, false, false)).toEqual({ kind: "show", id: c.id });
    expect(resolvePending([], { ...step, otherwise: "close" }, false, false)).toEqual({ kind: "close" });
    expect(resolvePending([a], { index: 1, skip: a.id, otherwise: "stay" }, false, false)).toEqual({
      kind: "stay",
    });
  });
});

describe("format", () => {
  test("download names follow §4.4 in local time", () => {
    const created = new Date(2026, 8, 23, 9, 5).toISOString();
    expect(
      downloadName({
        id: "01K6BQ8000000000000000ABCD",
        createdAt: created,
        modelId: "GPT Image 2",
        mime: "image/jpeg",
      }),
    ).toBe("openfield_20260923-0905_gpt-image-2_0000abcd.jpg");
  });

  test("thumbnails keep the server's own flags", () => {
    const trashed = { id: "x", thumbUrl: "/files/thumb/x?h=456&trash=1" };
    expect(thumbAt(trashed, { h: 360 })).toBe("/files/thumb/x?trash=1&h=360");
    expect(thumbAt(trashed, "preview")).toBe("/files/thumb/x?trash=1&p=1440");
  });

  test("frozen settings read what they can and skip the rest", () => {
    expect(
      frozenSettings({
        prompt: "a teapot",
        model: "google:banana",
        resolution: "2K",
        size: { aspect: "3:4" },
        speed: "standard",
        speedRequested: "flex",
      }),
    ).toEqual({
      prompt: "a teapot",
      model: "google:banana",
      resolution: "2K",
      aspect: "3:4",
      size: { aspect: "3:4" },
      speed: "standard",
      speedRequested: "flex",
    });
    const pixels = frozenSettings({ size: { width: 1536, height: 2048 }, model: 42, speed: "warp" });
    expect(pixels.aspect).toBe("3:4");
    expect(pixels.size).toEqual({ width: 1536, height: 2048 });
    expect(pixels.model).toBeUndefined();
    expect(pixels.speed).toBeUndefined();
    expect(frozenSettings(null)).toEqual({});
  });

  test("a video run's settings come back under video, a malformed block dropped whole", () => {
    const frozen = frozenSettings({
      prompt: "a kite",
      model: "byteplus:seedance-2-0-fast",
      size: { aspect: "16:9" },
      video: {
        seconds: 8,
        resolution: "720p",
        audio: true,
        startFrame: { assetId: "01K6BQ8000000000000000ABCD" },
      },
    });
    expect(frozen.video).toEqual({
      seconds: 8,
      resolution: "720p",
      audio: true,
      startFrame: { assetId: "01K6BQ8000000000000000ABCD" },
    });
    // A field that doesn't parse fails the whole (strict) block, same as an unreadable size does.
    expect(frozenSettings({ video: { seconds: "soon" } }).video).toBeUndefined();
    // An empty video object parses fine but says nothing, so it's left out too.
    expect(frozenSettings({ video: {} }).video).toBeUndefined();
  });

  test("relative times read in sentence case, then as a date", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(relativeTime("2026-09-24T11:59:40Z", now)).toBe("A moment ago");
    expect(relativeTime("2026-09-24T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-09-23T12:00:00Z", now)).toBe("Yesterday");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("Sep 1, 2026");
  });

  test("the Trash caption names the day it was deleted", () => {
    const now = new Date(2026, 8, 24, 12);
    expect(inTrashCaption(new Date(2026, 8, 24, 9).toISOString(), now)).toBe("In the trash since today");
    expect(inTrashCaption(new Date(2026, 8, 23, 9).toISOString(), now)).toBe("In the trash since yesterday");
    expect(inTrashCaption(new Date(2026, 8, 2, 9).toISOString(), now)).toBe("In the trash since Sep 2, 2026");
  });
});
