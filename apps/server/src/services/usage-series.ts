import {
  bucketOf,
  bucketsBetween,
  DEFAULT_CURRENCY,
  type JobSource,
  localDay,
  localHour,
  type UsageFigures,
  type UsageGrouping,
  type UsagePlace,
  type UsageSeriesBucket,
  type UsageSeriesGroup,
  type UsageSeriesResponse,
  type UsageStep,
} from "@openfield/core";
import type { UsageMinuteRow } from "@openfield/db";

// Settings > Spending (§6.9): the log's minutes put on the viewer's own clock, then summed per
// hour, day, week or month and per model, company, size or place. Every bucket in the range is
// returned, empty ones too, so the chart never skips a quiet day.

const PLACES: Record<JobSource, UsagePlace> = {
  composer: "image",
  recreate: "image",
  detail_editor: "edit",
  canvas: "canvas",
  api: "other",
};

export const placeOf = (source: JobSource | null): UsagePlace => (source ? PLACES[source] : "other");

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

const zero = (): UsageFigures => ({ runs: 0, images: 0, usd: 0, usdDiscarded: 0, canceled: 0, reruns: 0 });

function add(into: UsageFigures, row: UsageMinuteRow) {
  into.runs += row.runs;
  into.images += row.images;
  into.usd = round(into.usd + row.usd);
  into.usdDiscarded = round(into.usdDiscarded + row.usdDiscarded);
  into.canceled += row.canceled;
  into.reruns += row.reruns;
}

type GroupId = Omit<UsageSeriesGroup, keyof UsageFigures>;

function groupOf(row: UsageMinuteRow, groupBy: UsageGrouping): GroupId {
  switch (groupBy) {
    case "model":
      return { key: `${row.providerId}:${row.modelId}`, providerId: row.providerId, modelId: row.modelId };
    case "provider":
      return { key: row.providerId, providerId: row.providerId };
    case "size":
      return {
        key: `${row.resolution ?? ""}|${row.quality ?? ""}`,
        resolution: row.resolution,
        quality: row.quality,
      };
    case "place": {
      // What an agent app asked for is grouped by app, whether it landed in the feed or a canvas.
      if (row.agent) return { key: `agent:${row.agent}`, place: "agent", agent: row.agent };
      const place = placeOf(row.source);
      return { key: place, place };
    }
  }
}

export interface SeriesOptions {
  /** Included, ISO. Absent: from the first row. */
  from?: string | undefined;
  /** Excluded, ISO. Absent: up to `now`. */
  to?: string | undefined;
  now: Date;
  tz: string;
  step: UsageStep;
  groupBy: UsageGrouping;
  /** The first row ever logged, for "Nothing tracked before…". */
  firstAt: string | null;
}

export function buildUsageSeries(rows: readonly UsageMinuteRow[], opts: SeriesOptions): UsageSeriesResponse {
  const { tz, step, groupBy } = opts;
  // Every zone's offset is a multiple of 15 minutes, so one lookup per quarter hour is exact.
  const hours = new Map<string, string>();
  const hourOf = (minute: string) => {
    const slot = `${minute.slice(0, 14)}${Math.floor(Number(minute.slice(14, 16)) / 15)}`;
    let hour = hours.get(slot);
    if (!hour) {
      hour = localHour(`${minute}:00.000Z`, tz);
      hours.set(slot, hour);
    }
    return hour;
  };
  const bucketKey = (hour: string) => (step === "hour" ? hour : bucketOf(hour.slice(0, 10), step));
  const local = (instant: string | Date) =>
    step === "hour" ? localHour(instant, tz) : localDay(instant, tz);

  const buckets = new Map<string, UsageSeriesBucket>();
  const firstHour = rows[0] ? hourOf(rows[0].minute) : undefined;
  const first = opts.from
    ? local(opts.from)
    : firstHour && (step === "hour" ? firstHour : firstHour.slice(0, 10));
  const last = opts.to ? local(new Date(Date.parse(opts.to) - 1)) : local(opts.now);
  if (first && first <= last) {
    for (const start of bucketsBetween(first, last, step)) buckets.set(start, { start, groups: {} });
  }

  const groups = new Map<string, UsageSeriesGroup>();
  const totals = zero();
  const models = new Set<string>();
  for (const row of rows) {
    const id = groupOf(row, groupBy);
    let group = groups.get(id.key);
    if (!group) {
      group = { ...id, ...zero() };
      groups.set(id.key, group);
    }
    add(group, row);
    add(totals, row);
    models.add(`${row.providerId}:${row.modelId}`);

    const start = bucketKey(hourOf(row.minute));
    let bucket = buckets.get(start);
    if (!bucket) {
      // Only when the clock and the log disagree, say a row stamped after `now`. Kept, not lost.
      bucket = { start, groups: {} };
      buckets.set(start, bucket);
    }
    const cell = bucket.groups[id.key] ?? { usd: 0, images: 0 };
    bucket.groups[id.key] = cell;
    cell.usd = round(cell.usd + row.usd);
    cell.images += row.images;
  }

  return {
    step,
    groupBy,
    buckets: [...buckets.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    groups: [...groups.values()].sort(
      (a, b) => b.usd - a.usd || b.images - a.images || (a.key < b.key ? -1 : 1),
    ),
    totals,
    models: models.size,
    firstDay: opts.firstAt ? localDay(opts.firstAt, tz) : null,
    currency: DEFAULT_CURRENCY,
  };
}
