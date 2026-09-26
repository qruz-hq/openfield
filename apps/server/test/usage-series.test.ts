import { afterEach, describe, expect, test } from "bun:test";
import {
  type NormalizedRequest,
  newId,
  type UsageSeriesResponse,
  usageSeriesResponseSchema,
} from "@openfield/core";
import { createJobSet, insertUsage, type UsageMinuteRow } from "@openfield/db";
import { buildUsageSeries, placeOf } from "../src/services/usage-series";
import { startTestServer, type TestServer } from "./helpers";

// Settings > Spending (§6.9): the log on the viewer's clock, by hour, day, week or month, split by
// model, company, size or place, with every quiet bucket still in the answer.

const row = (minute: string, over: Partial<UsageMinuteRow> = {}): UsageMinuteRow => ({
  minute,
  providerId: "google",
  modelId: "gemini-3-pro-image",
  resolution: null,
  quality: null,
  source: "composer",
  runs: 1,
  images: 1,
  usd: 0.134,
  usdDiscarded: 0,
  canceled: 0,
  reruns: 0,
  ...over,
});

const opts = {
  now: new Date("2026-09-26T12:00:00.000Z"),
  tz: "UTC",
  step: "day" as const,
  groupBy: "model" as const,
  firstAt: "2026-09-01T09:00:00.000Z",
};

describe("building the series", () => {
  test("a late run lands on the viewer's day, and quiet days stay as zeros", () => {
    const series = buildUsageSeries([row("2026-09-20T02:30")], {
      ...opts,
      tz: "America/Los_Angeles",
      from: "2026-09-18T07:00:00.000Z",
      to: "2026-09-21T07:00:00.000Z",
    });
    expect(series.buckets.map((b) => b.start)).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
    expect(series.buckets[1]!.groups).toEqual({ "google:gemini-3-pro-image": { usd: 0.134, images: 1 } });
    expect(series.buckets[0]!.groups).toEqual({});
    expect(series.firstDay).toBe("2026-09-01");
  });

  test("weeks start on Monday and months on the 1st", () => {
    const rows = [row("2026-09-06T10:00"), row("2026-09-07T10:00"), row("2026-09-26T10:00")];
    const weeks = buildUsageSeries(rows, { ...opts, step: "week", from: "2026-09-01T00:00:00.000Z" });
    expect(weeks.buckets.map((b) => [b.start, Object.values(b.groups)[0]?.images ?? 0])).toEqual([
      ["2026-08-31", 1],
      ["2026-09-07", 1],
      ["2026-09-14", 0],
      ["2026-09-21", 1],
    ]);
    const months = buildUsageSeries(rows, { ...opts, step: "month", from: "2026-08-01T00:00:00.000Z" });
    expect(months.buckets.map((b) => b.start)).toEqual(["2026-08-01", "2026-09-01"]);
    expect(months.totals.images).toBe(3);
  });

  test("a day by the hour", () => {
    const series = buildUsageSeries([row("2026-09-26T09:59"), row("2026-09-26T10:00")], {
      ...opts,
      step: "hour",
      from: "2026-09-26T00:00:00.000Z",
      to: "2026-09-27T00:00:00.000Z",
    });
    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[9]!.groups["google:gemini-3-pro-image"]?.images).toBe(1);
    expect(series.buckets[10]!.groups["google:gemini-3-pro-image"]?.images).toBe(1);
  });

  test("all time starts at the first row and runs to today", () => {
    const series = buildUsageSeries([row("2026-09-24T23:00")], opts);
    expect(series.buckets.map((b) => b.start)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(buildUsageSeries([], opts).buckets).toEqual([]);
  });

  test("splits by company, size and quality, or where it was made", () => {
    const rows = [
      row("2026-09-20T10:00", { resolution: "2K", quality: "high", source: "canvas" }),
      row("2026-09-20T11:00", {
        providerId: "openai",
        modelId: "gpt-image-2",
        usd: 0.06,
        source: "recreate",
      }),
      row("2026-09-20T12:00", { source: "detail_editor", usd: 0.2 }),
    ];
    const from = "2026-09-20T00:00:00.000Z";
    expect(buildUsageSeries(rows, { ...opts, from, groupBy: "provider" }).groups.map((g) => g.key)).toEqual([
      "google",
      "openai",
    ]);
    expect(buildUsageSeries(rows, { ...opts, from, groupBy: "size" }).groups).toMatchObject([
      { key: "|", resolution: null, quality: null, images: 2 },
      { key: "2K|high", resolution: "2K", quality: "high", images: 1 },
    ]);
    const places = buildUsageSeries(rows, { ...opts, from, groupBy: "place" });
    expect(places.groups.map((g) => [g.key, g.usd])).toEqual([
      ["edit", 0.2],
      ["canvas", 0.134],
      ["image", 0.06],
    ]);
    expect(places.models).toBe(2);
  });

  test("Recreate counts as the Image page, and a run with no job set as somewhere else", () => {
    expect(placeOf("composer")).toBe("image");
    expect(placeOf("recreate")).toBe("image");
    expect(placeOf("detail_editor")).toBe("edit");
    expect(placeOf("canvas")).toBe("canvas");
    expect(placeOf(null)).toBe("other");
  });

  test("totals add up without float drift", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`2026-09-20T10:0${i}`, { usd: 0.1 }));
    const series = buildUsageSeries(rows, { ...opts, from: "2026-09-20T00:00:00.000Z" });
    expect(series.totals.usd).toBe(1);
    expect(
      series.buckets.find((b) => b.start === "2026-09-20")!.groups["google:gemini-3-pro-image"]!.usd,
    ).toBe(1);
  });
});

describe("GET /api/usage/series", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test("answers from the log, in the zone asked for", async () => {
    server = await startTestServer();
    const db = server.services.db;
    const set = createJobSet(db, {
      jobSet: {
        id: newId(),
        op: "generate",
        providerId: "google",
        modelId: "gemini-3-pro-image",
        requestJson: { resolution: "4K" } as NormalizedRequest,
        source: "canvas",
      },
      jobs: [{ id: newId(), idx: 0 }],
    }).jobSet;
    const base = { providerId: "google", modelId: "gemini-3-pro-image", operation: "generate" as const };
    insertUsage(db, {
      ...base,
      jobSetId: set.id,
      ts: "2026-09-20T02:30:00.000Z",
      outcome: "succeeded",
      costUsd: 0.24,
    });
    insertUsage(db, { ...base, ts: "2026-09-20T03:00:00.000Z", outcome: "failed", costUsd: 0 });

    const query = new URLSearchParams({
      from: "2026-09-19T07:00:00.000Z",
      to: "2026-09-21T07:00:00.000Z",
      tz: "America/Los_Angeles",
      step: "day",
      groupBy: "size",
    });
    const res = await server.json<UsageSeriesResponse>(`/api/usage/series?${query}`);
    expect(res.status).toBe(200);
    const body = usageSeriesResponseSchema.parse(res.body);
    expect(body.buckets.map((b) => b.start)).toEqual(["2026-09-19", "2026-09-20"]);
    expect(body.buckets[0]!.groups).toEqual({ "4K|": { usd: 0.24, images: 1 } });
    expect(body.totals).toEqual({ runs: 1, images: 1, usd: 0.24, usdDiscarded: 0, canceled: 0, reruns: 0 });
    expect(body.firstDay).toBe("2026-09-19");
  });

  test("refuses a time zone it doesn't know", async () => {
    server = await startTestServer();
    const res = await server.json("/api/usage/series?tz=Mars%2FOlympus");
    expect(res.status).toBe(400);
  });
});
