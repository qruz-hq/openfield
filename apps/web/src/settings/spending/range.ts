import { addDays, addMonths, daysBetween, formatLocale, localDay, type UsageStep } from "@openfield/core";

// Settings > Spending's dates (§6.9). Days are "YYYY-MM-DD" on this computer's clock, which is also
// the zone the server buckets by, so a range and its buckets always agree.

export const RANGE_PRESETS = ["today", "7d", "30d", "90d", "12m", "all"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** A preset, or two days picked by hand (both included). */
export type RangeChoice =
  | { kind: "preset"; preset: RangePreset }
  | { kind: "custom"; from: string; to: string };

export interface ResolvedRange {
  choice: RangeChoice;
  /** First day, included. */
  from: string;
  /** Last day, included. */
  to: string;
  /** How many days, both ends counted. */
  days: number;
}

/** This computer's zone, sent with every query. */
export const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const todayOf = (now: Date = new Date()): string => localDay(now, viewerZone());

/** Local midnight at the start of a day. */
export function startOf(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

/**
 * The days a choice covers. All time starts the first day anything was tracked, today when
 * nothing was. The last 12 months are whole months, this one included, so they chart as 12 bars.
 */
export function resolveRange(choice: RangeChoice, today: string, firstDay: string | null): ResolvedRange {
  const span = (from: string, to: string): ResolvedRange => ({
    choice,
    from,
    to,
    days: daysBetween(from, to) + 1,
  });
  if (choice.kind === "custom") {
    return choice.from <= choice.to ? span(choice.from, choice.to) : span(choice.to, choice.from);
  }
  switch (choice.preset) {
    case "today":
      return span(today, today);
    case "7d":
      return span(addDays(today, -6), today);
    case "30d":
      return span(addDays(today, -29), today);
    case "90d":
      return span(addDays(today, -89), today);
    case "12m":
      return span(addMonths(today, -11), today);
    case "all":
      return span(firstDay && firstDay < today ? firstDay : today, today);
  }
}

/** The instants to ask the server for. A preset runs up to now; custom dates end at midnight. */
export function rangeQuery(range: ResolvedRange): { from?: string; to?: string } {
  const { choice } = range;
  if (choice.kind === "preset" && choice.preset === "all") return {};
  const from = startOf(range.from).toISOString();
  if (choice.kind === "preset") return { from };
  return { from, to: startOf(addDays(range.to, 1)).toISOString() };
}

/** The same length of time just before, for "Versus the 30 days before". None for All time. */
export function previousRange(range: ResolvedRange): { from: string; to: string } | null {
  const { choice } = range;
  if (choice.kind === "preset" && choice.preset === "all") return null;
  if (choice.kind === "preset" && choice.preset === "12m") {
    return { from: addMonths(range.from, -12), to: addDays(range.from, -1) };
  }
  return { from: addDays(range.from, -range.days), to: addDays(range.from, -1) };
}

/** Instants for a span of days, both ends included. */
export const spanQuery = (span: { from: string; to: string }) => ({
  from: startOf(span.from).toISOString(),
  to: startOf(addDays(span.to, 1)).toISOString(),
});

/**
 * The steps that draw a readable chart. A single day goes by the hour. Days stop past about six
 * months, weeks need three of them, months need two.
 */
export function allowedSteps(range: ResolvedRange): UsageStep[] {
  if (range.days === 1) return ["hour"];
  const out: UsageStep[] = [];
  if (range.days <= 190) out.push("day");
  if (range.days >= 21) out.push("week");
  if (range.days >= 60) out.push("month");
  return out;
}

/** Keeps the step picked when the range allows it, else the one that reads best for its length. */
export function pickStep(wanted: UsageStep, range: ResolvedRange): UsageStep {
  const allowed = allowedSteps(range);
  if (allowed.includes(wanted)) return wanted;
  if (range.days > 190 && allowed.includes("month")) return "month";
  return allowed[0] ?? "day";
}

/**
 * Clicking a month shows its weeks, and a week its days. Never past today: the future has nothing
 * to show.
 */
export function drillInto(
  start: string,
  step: UsageStep,
  today: string,
): { choice: RangeChoice; step: UsageStep } | null {
  const end =
    step === "month" ? addDays(addMonths(start, 1), -1) : step === "week" ? addDays(start, 6) : null;
  if (!end) return null;
  return {
    choice: { kind: "custom", from: start, to: end < today ? end : today },
    step: step === "month" ? "week" : "day",
  };
}

/** A day as a Date at UTC midnight, so formatting in UTC shows that same day everywhere. */
const utcDate = (day: string) =>
  new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(formatLocale(), { timeZone: "UTC", ...opts });

/** "Sep 19". */
export const formatDay = (day: string) => fmt({ month: "short", day: "numeric" }).format(utcDate(day));

/** "Sep 1, 2026". */
export const formatDayLong = (day: string) => fmt({ dateStyle: "medium" }).format(utcDate(day));

/** "Sep 1 – 26, 2026", in the locale's own words. */
export const formatDaySpan = (from: string, to: string) =>
  from === to ? formatDayLong(from) : fmt({ dateStyle: "medium" }).formatRange(utcDate(from), utcDate(to));

/** The x axis under a bucket. Months name the year on the first bar and every January. */
export function axisLabel(start: string, step: UsageStep, first: boolean): string {
  if (step === "hour") return fmt({ hour: "numeric" }).format(new Date(`${start}:00:00.000Z`));
  if (step !== "month") return formatDay(start);
  const withYear = first || start.slice(5, 7) === "01";
  return fmt(withYear ? { month: "short", year: "numeric" } : { month: "short" }).format(utcDate(start));
}

/** The tooltip's heading: "Sat, Sep 19", "Sep 21 – 27, 2026", "August 2026", "9 AM". */
export function bucketTitle(start: string, step: UsageStep): string {
  switch (step) {
    case "hour":
      return fmt({ hour: "numeric" }).format(new Date(`${start}:00:00.000Z`));
    case "day":
      return fmt({ weekday: "short", month: "short", day: "numeric" }).format(utcDate(start));
    case "week":
      return formatDaySpan(start, addDays(start, 6));
    case "month":
      return fmt({ month: "long", year: "numeric" }).format(utcDate(start));
  }
}
