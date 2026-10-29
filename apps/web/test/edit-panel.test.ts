// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
import { aspectText, pickEditModel, resultSlots, runOutcome, savedNote } from "../src/detail/edit/plan";
import { useEditSession } from "../src/detail/edit/session";
import { at, banana, flare, flareEdit, jobSet, lite, pro } from "./fixtures";

// The Edit tab's panel without a DOM: which model an edit runs on, how the image's shape reads,
// and what a run came to.

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
