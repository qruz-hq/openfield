// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
import { isTurnedOrientation, jpegOrientation } from "../src/detail/edit/exif";
import {
  aspectText,
  comparedResult,
  pickEditModel,
  resultSlots,
  runOutcome,
  savedNote,
} from "../src/detail/edit/plan";
import { useEditSession } from "../src/detail/edit/session";
import { at, banana, flare, flareEdit, jobSet, lite, pro } from "./fixtures";

// The Edit tab's panel without a DOM: which model an edit runs on, how the image's shape reads,
// what a run came to, and the EXIF tag that says a photo is stored on its side.

describe("the model an edit runs on", () => {
  const models: ModelListItem[] = [banana, pro, flareEdit, lite];

  test("one that takes a mask comes first, even when a whole-image model is listed before it", () => {
    expect(pickEditModel(models, null, null)?.key).toBe(flareEdit.key);
  });

  test("the one picked stays while it can edit", () => {
    expect(pickEditModel(models, pro.key, null)?.key).toBe(pro.key);
  });

  test("a pick that can't edit, or isn't listed, falls back", () => {
    const noEdit: ModelListItem = {
      ...lite,
      key: "google:no-edit",
      capabilities: { ...lite.capabilities, ops: { ...lite.capabilities.ops, imageEdit: false } },
    };
    expect(pickEditModel([...models, noEdit], noEdit.key, null)?.key).toBe(flareEdit.key);
    expect(pickEditModel(models, "google:gone", null)?.key).toBe(flareEdit.key);
  });

  test("with only whole-image models ready, the first of those (design 3eiWurzdNj)", () => {
    const locked = { ...flareEdit, ready: false };
    expect(pickEditModel([locked, pro, lite], null, null)?.key).toBe(pro.key);
  });

  test("the default model leads when it takes a mask, and an early company is never picked", () => {
    const second: ModelListItem = { ...flareEdit, key: "openai:second", modelId: "second" };
    expect(pickEditModel([flareEdit, second], null, second.key)?.key).toBe(second.key);
    const early = [{ id: "openai", meta: { stable: false } }] as never;
    expect(pickEditModel([flareEdit, pro], null, null, early)?.key).toBe(pro.key);
  });

  test("no model ready: none", () => {
    expect(pickEditModel([{ ...flare, ready: false }], null, null)).toBeUndefined();
  });
});

describe("the image's shape", () => {
  test("in its own terms when they're small", () => {
    expect(aspectText(1152, 1536)).toBe("3:4");
    expect(aspectText(1920, 1080)).toBe("16:9");
    expect(aspectText(1024, 1024)).toBe("1:1");
  });

  test("as the nearest common ratio when they aren't", () => {
    expect(aspectText(1000, 1333)).toBe("3:4");
  });
});

describe("what a run came to", () => {
  const withAssets = (statuses: Parameters<typeof jobSet>[1], done = "succeeded") => {
    const set = jobSet(at(0), statuses);
    set.jobs = set.jobs.map((job, i) => ({
      ...job,
      assetId: job.status === done ? `01K6BQ80000000000000ASSET${i}` : null,
    }));
    return set;
  };

  test("its images in batch order, each working, done or not", () => {
    const set = withAssets(["succeeded", "running", "failed"]);
    set.jobs.reverse();
    expect(resultSlots(set).map((s) => s.state)).toEqual(["done", "working", "failed"]);
    expect(resultSlots(undefined)).toEqual([]);
  });

  test("working, saved, failed or stopped", () => {
    expect(runOutcome(undefined)).toEqual({ kind: "none" });
    expect(runOutcome(withAssets(["running", "queued"]))).toEqual({ kind: "working", count: 2 });
    const partial = withAssets(["succeeded", "failed"]);
    partial.jobSet.status = "partial";
    expect(runOutcome(partial)).toEqual({ kind: "saved", saved: 1, failed: 1 });
    const failed = withAssets(["failed", "failed"]);
    failed.jobSet.status = "failed";
    expect(runOutcome(failed)).toEqual({ kind: "failed" });
    const stopped = withAssets(["canceled", "canceled"]);
    stopped.jobSet.status = "canceled";
    expect(runOutcome(stopped)).toEqual({ kind: "stopped" });
  });

  test("a new image picked is compared with the original; the original picked goes back to painting", () => {
    const saved = { kind: "saved", saved: 2, failed: 0 } as const;
    expect(comparedResult(saved, "01K6BQ80000000000000ASSET0")).toBe("01K6BQ80000000000000ASSET0");
    expect(comparedResult(saved, null)).toBeNull();
    expect(comparedResult(saved, undefined)).toBeNull();
    // While it runs the mask stays in view, even with an image already in.
    expect(comparedResult({ kind: "working", count: 2 }, "01K6BQ80000000000000ASSET0")).toBeNull();
    expect(comparedResult({ kind: "failed" }, undefined)).toBeNull();
  });

  test("the saved note in the design's words", () => {
    expect(savedNote({ kind: "saved", saved: 2, failed: 0 })).toEqual({
      tone: "done",
      text: "Saved as 2 new images. The original stays as it is.",
    });
    expect(savedNote({ kind: "saved", saved: 1, failed: 1 })).toEqual({
      tone: "warning",
      text: "Saved 1 new image. 1 didn't work. Try again.",
    });
    expect(savedNote({ kind: "saved", saved: 2, failed: 0 }, true)).toEqual({
      tone: "warning",
      text: "Saved 2 new images, but the rest couldn't be kept exactly. Try again.",
    });
    expect(savedNote({ kind: "failed" })).toBeNull();
  });
});

describe("the session's settings", () => {
  test("feather and expand stay within what a request takes, and the size settings outlast an edit", () => {
    const session = useEditSession.getState();
    session.start("01K6BQ8000000000000000PANEL", 64, 48);
    session.setFeatherPx(40);
    session.setExpandPx(-3);
    expect(useEditSession.getState().featherPx).toBe(32);
    expect(useEditSession.getState().expandPx).toBe(0);
    session.setModel(pro.key);
    session.setValues({ resolution: "2K" });
    session.setValues({ quality: "high" });
    session.setBatch(3);
    session.setComposite(false);
    session.start("01K6BQ8000000000000000OTHER", 64, 48);
    const next = useEditSession.getState();
    expect(next.model).toBe(pro.key);
    expect(next.values).toEqual({ resolution: "2K", quality: "high" });
    expect(next.batch).toBe(3);
    expect(next.composite).toBe(true);
    expect(next.featherPx).toBe(8);
    session.end();
  });
});

/** A JPEG's first bytes: SOI, optional APP0, then APP1 with one orientation entry. */
function jpeg(orientation: number | null, opts: { little?: boolean; jfif?: boolean } = {}): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  if (opts.jfif) bytes.push(0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46);
  if (orientation !== null) {
    const u16 = (v: number) => (opts.little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
    const u32 = (v: number) =>
      opts.little ? [...u16(v & 0xffff), ...u16(v >>> 16)] : [...u16(v >>> 16), ...u16(v & 0xffff)];
    const tiff = [
      ...(opts.little ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(orientation),
      0,
      0,
      ...u32(0),
    ];
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    bytes.push(0xff, 0xe1, ...[(payload.length + 2) >> 8, (payload.length + 2) & 0xff], ...payload);
  }
  bytes.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(bytes);
}

describe("a photo stored on its side", () => {
  test("reads the orientation in either byte order, after a JFIF segment", () => {
    expect(jpegOrientation(jpeg(6))).toBe(6);
    expect(jpegOrientation(jpeg(8, { little: true }))).toBe(8);
    expect(jpegOrientation(jpeg(3, { jfif: true }))).toBe(3);
    expect(jpegOrientation(jpeg(1))).toBe(1);
  });

  test("no tag, or not a JPEG: none", () => {
    expect(jpegOrientation(jpeg(null))).toBeNull();
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegOrientation(new Uint8Array([]))).toBeNull();
    // Cut short inside the EXIF segment.
    expect(jpegOrientation(jpeg(6).slice(0, 20))).toBeNull();
  });

  test("turned is 2 to 8, as the server reads it", () => {
    expect(isTurnedOrientation(1)).toBe(false);
    expect(isTurnedOrientation(null)).toBe(false);
    expect(isTurnedOrientation(6)).toBe(true);
    expect(isTurnedOrientation(2)).toBe(true);
  });
});
