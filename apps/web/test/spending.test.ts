// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { UsageSeriesGroup, UsageSeriesResponse } from "@openfield/core";
import {
  axisIndices,
  bandPath,
  barLayout,
  linePath,
  monotoneSegments,
  monthProjection,
  nearestIndex,
  niceScale,
  shares,
  stack,
} from "../src/settings/spending/chart-math";
import {
  allowedSteps,
  drillInto,
  pickStep,
  previousRange,
  type RangeChoice,
  resolveRange,
} from "../src/settings/spending/range";
import { assignSlots, buildView, OTHER } from "../src/settings/spending/view";

// Settings > Spending (§6.9): the dates, the chart's geometry and which series get which colour.

const TODAY = "2026-09-26";
const preset = (p: "today" | "7d" | "30d" | "90d" | "12m" | "all"): RangeChoice => ({
  kind: "preset",
  preset: p,
});

describe("dates", () => {
  test("presets end today and count today in", () => {
    expect(resolveRange(preset("today"), TODAY, null)).toMatchObject({ from: TODAY, to: TODAY, days: 1 });
    expect(resolveRange(preset("30d"), TODAY, null)).toMatchObject({ from: "2026-08-28", days: 30 });
    // Whole months, this one included, so the Month step shows 12 bars.
    expect(resolveRange(preset("12m"), TODAY, null)).toMatchObject({ from: "2025-10-01", to: TODAY });
  });

  test("all time starts on the first tracked day", () => {
    expect(resolveRange(preset("all"), TODAY, "2026-01-15")).toMatchObject({ from: "2026-01-15" });
    expect(resolveRange(preset("all"), TODAY, null)).toMatchObject({ from: TODAY });
  });

  test("custom dates picked the wrong way round still read left to right", () => {
    expect(resolveRange({ kind: "custom", from: "2026-09-20", to: "2026-09-01" }, TODAY, null)).toMatchObject(
      {
        from: "2026-09-01",
        to: "2026-09-20",
        days: 20,
      },
    );
  });

  test("the span before has the same length, and All time has none", () => {
    expect(previousRange(resolveRange(preset("30d"), TODAY, null))).toEqual({
      from: "2026-07-29",
      to: "2026-08-27",
    });
    expect(previousRange(resolveRange(preset("today"), TODAY, null))).toEqual({
      from: "2026-09-25",
      to: "2026-09-25",
    });
    expect(previousRange(resolveRange(preset("12m"), TODAY, null))).toEqual({
      from: "2024-10-01",
      to: "2025-09-30",
    });
    expect(previousRange(resolveRange(preset("all"), TODAY, "2026-01-01"))).toBeNull();
  });
});

describe("steps", () => {
  test("only steps that draw a readable chart", () => {
    expect(allowedSteps(resolveRange(preset("today"), TODAY, null))).toEqual(["hour"]);
    expect(allowedSteps(resolveRange(preset("7d"), TODAY, null))).toEqual(["day"]);
    expect(allowedSteps(resolveRange(preset("30d"), TODAY, null))).toEqual(["day", "week"]);
    expect(allowedSteps(resolveRange(preset("90d"), TODAY, null))).toEqual(["day", "week", "month"]);
    expect(allowedSteps(resolveRange(preset("12m"), TODAY, null))).toEqual(["week", "month"]);
  });

  test("keeps the step picked when it fits, else reads by month past six months", () => {
    const year = resolveRange(preset("12m"), TODAY, null);
    expect(pickStep("week", year)).toBe("week");
    expect(pickStep("day", year)).toBe("month");
    expect(pickStep("month", resolveRange(preset("7d"), TODAY, null))).toBe("day");
    expect(pickStep("week", resolveRange(preset("today"), TODAY, null))).toBe("hour");
  });

  test("a month opens its weeks and a week its days, never past today", () => {
    expect(drillInto("2026-08-01", "month", TODAY)).toEqual({
      choice: { kind: "custom", from: "2026-08-01", to: "2026-08-31" },
      step: "week",
    });
    expect(drillInto("2026-09-21", "week", TODAY)).toEqual({
      choice: { kind: "custom", from: "2026-09-21", to: TODAY },
      step: "day",
    });
    expect(drillInto("2026-09-21", "day", TODAY)).toBeNull();
  });
});

describe("chart geometry", () => {
  test("ticks are round numbers just past the highest value", () => {
    expect(niceScale(1.08)).toEqual({ max: 1.25, ticks: [0, 0.25, 0.5, 0.75, 1, 1.25] });
    expect(niceScale(23.1).max).toBe(25);
    expect(niceScale(0).max).toBe(1);
    // Image counts stay whole.
    expect(niceScale(3, true).ticks).toEqual([0, 1, 2, 3]);
    expect(niceScale(0, true).ticks.every(Number.isInteger)).toBe(true);
  });

  test("curves never dip below a quiet day", () => {
    const points = [
      [0, 100],
      [10, 232],
      [20, 232],
      [30, 50],
    ] as const;
    const ys = monotoneSegments(points)
      .match(/-?\d+(\.\d+)?,-?\d+(\.\d+)?/g)!
      .map((pair) => Number(pair.split(",")[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(232);
    expect(linePath(points).startsWith("M0,100 C")).toBe(true);
    expect(bandPath(points, points).endsWith(" Z")).toBe(true);
  });

  test("stacks series bottom first", () => {
    expect(
      stack([
        [1, 2],
        [3, 0],
      ]),
    ).toEqual([
      [1, 2],
      [4, 2],
    ]);
  });

  test("bars are at most 24 wide and never fill their slot", () => {
    expect(barLayout(12, 1087).bar).toBe(24);
    const dense = barLayout(365, 1087);
    expect(dense.bar).toBeLessThan(dense.slot);
    expect(nearestIndex(60, [52, 100, 200])).toBe(0);
    expect(nearestIndex(160, [52, 100, 200])).toBe(2);
  });

  test("x labels skip evenly and always name the last bucket", () => {
    expect(axisIndices(30, 5, true)).toEqual([0, 5, 10, 15, 20, 25, 29]);
    // The last lands on a label already.
    expect(axisIndices(29, 4, true)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    // 28 is too close to the last, 29, so it gives way.
    expect(axisIndices(30, 4, true)).toEqual([0, 4, 8, 12, 16, 20, 24, 29]);
    expect(axisIndices(12, 1, false)).toHaveLength(12);
    expect(axisIndices(1, 3, true)).toEqual([0]);
  });

  test("shares always add up to 100", () => {
    const split = shares([76.35, 30.56, 17.74, 16.64, 12.68]);
    expect(split).toEqual([50, 20, 11, 11, 8]);
    expect(shares([1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(shares([0, 0])).toEqual([0, 0]);
  });

  test("the month-end guess scales the daily average, and waits for day 2", () => {
    expect(monthProjection(14.27, TODAY)).toEqual({ amount: (14.27 / 26) * 30, lastDay: "2026-09-30" });
    expect(monthProjection(3, "2026-02-01")).toBeNull();
    expect(monthProjection(0, TODAY)).toBeNull();
  });
});

const group = (key: string, usd: number): UsageSeriesGroup => ({
  key,
  providerId: "google",
  modelId: key,
  runs: 1,
  images: 1,
  usd,
  usdDiscarded: 0,
  canceled: 0,
  reruns: 0,
});

function response(groups: UsageSeriesGroup[]): UsageSeriesResponse {
  return {
    step: "day",
    groupBy: "model",
    buckets: [
      {
        start: "2026-09-25",
        groups: Object.fromEntries(groups.map((g) => [g.key, { usd: g.usd, images: 1 }])),
      },
      { start: "2026-09-26", groups: {} },
    ],
    groups,
    totals: { runs: groups.length, images: groups.length, usd: 0, usdDiscarded: 0, canceled: 0, reruns: 0 },
    models: groups.length,
    firstDay: "2026-09-25",
    currency: "USD",
  };
}

describe("series and colours", () => {
  test("a model keeps its colour when the order changes", () => {
    const first = assignSlots(["a", "b"], {});
    expect([...first.slots]).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    // b now spends more, and c is new: nobody repaints, c takes the first free colour.
    const next = assignSlots(["b", "c", "a"], first.saved);
    expect(next.slots.get("b")).toBe(1);
    expect(next.slots.get("a")).toBe(0);
    expect(next.slots.get("c")).toBe(2);
  });

  test("the eighth group and beyond fold into Other", () => {
    const groups = Array.from({ length: 9 }, (_, i) => group(`m${i}`, 10 - i));
    const view = buildView(response(groups), { hidden: [], saved: {} });
    expect(view.series.map((s) => s.key)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", OTHER]);
    const other = view.series.at(-1)!;
    expect(other.slot).toBe(-1);
    expect(other.groups.map((g) => g.key)).toEqual(["m7", "m8"]);
    expect(other.usd).toEqual([5, 0]);
  });

  test("hidden series drop out of the totals, and only there", () => {
    const view = buildView(response([group("a", 2), group("b", 1)]), { hidden: ["a"], saved: {} });
    expect(view.series.map((s) => [s.key, s.hidden])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(view.visible.usd).toBe(1);
    expect(view.series[0]!.usd).toEqual([2, 0]);
  });

  test("says when the colour memory needs saving", () => {
    const view = buildView(response([group("a", 2)]), { hidden: [], saved: {} });
    expect(view.saved).toEqual({ a: 0 });
    expect(buildView(response([group("a", 2)]), { hidden: [], saved: { a: 0 } }).saved).toBeNull();
  });
});
