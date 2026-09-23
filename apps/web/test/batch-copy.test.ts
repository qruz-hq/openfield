// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { type BatchNameLookups, batchDoneCopy, batchNotice } from "../src/lib/batch-copy";

const base = { model: "Nano Banana Pro", company: "Google" };
const counts = (succeeded: number, total = 4) => ({
  total,
  succeeded,
  failed: total - succeeded,
  pending: 0,
});
const frame = (state: "succeeded" | "failed" | "expired", made: number) => ({
  state,
  counts: counts(made),
  submittedAt: "2026-09-21T10:00:00.000Z",
  expiresAt: "2026-09-23T10:00:00.000Z",
});

describe("batchDoneCopy", () => {
  test("every image made", () => {
    expect(batchDoneCopy({ ...base, frame: frame("succeeded", 4) })).toEqual({
      title: "Your batch is ready",
      detail: "4 images from Nano Banana Pro",
      made: true,
      body: "Your batch is ready. 4 images from Nano Banana Pro.",
    });
  });

  test("some made", () => {
    expect(batchDoneCopy({ ...base, frame: frame("succeeded", 3) }).detail).toBe(
      "3 of 4 images from Nano Banana Pro",
    );
  });

  test("none made", () => {
    const copy = batchDoneCopy({ ...base, frame: frame("failed", 0) });
    expect(copy).toEqual({
      title: "Your batch didn't make any images",
      detail: undefined,
      made: false,
      body: "Your batch didn't make any images",
    });
  });

  test("expired at the company", () => {
    expect(batchDoneCopy({ ...base, frame: frame("expired", 0) }).title).toBe(
      "Google didn't finish your batch within 48 hours",
    );
  });

  test("counts the feed's jobs when the frame has none", () => {
    const copy = batchDoneCopy({
      ...base,
      frame: { state: "succeeded", submittedAt: null, expiresAt: null },
      jobs: [{ status: "succeeded" }, { status: "failed" }],
    });
    expect(copy.detail).toBe("1 of 2 images from Nano Banana Pro");
  });
});

describe("batchNotice", () => {
  // A tab opened after the run finished: the first frame lands before any list has loaded.
  const snapshot = {
    ...frame("succeeded", 2),
    counts: counts(2, 2),
    modelKey: "google:gemini-3-pro-image-preview" as const,
    providerId: "google",
  };
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));

  test("waits for the names instead of reading lists that aren't loaded yet", async () => {
    const asked: string[] = [];
    const lookups: BatchNameLookups = {
      model: (key) => {
        asked.push(key);
        return later("Nano Banana Pro");
      },
      company: () => later("Google"),
    };
    const copy = await batchNotice(snapshot, undefined, lookups);
    expect(asked).toEqual(["google:gemini-3-pro-image-preview"]);
    expect(copy.body).toBe("Your batch is ready. 2 images from Nano Banana Pro.");
  });

  test("leaves the names out when they can't be loaded, never a blank", async () => {
    const lookups: BatchNameLookups = {
      model: () => Promise.reject(new Error("offline")),
      company: () => later(undefined),
    };
    expect((await batchNotice(snapshot, undefined, lookups)).body).toBe("Your batch is ready. 2 images.");
    const expired = await batchNotice(
      { ...snapshot, state: "expired", counts: counts(0, 2) },
      undefined,
      lookups,
    );
    expect(expired.body).toBe("Your batch didn't finish within 48 hours");
  });
});
