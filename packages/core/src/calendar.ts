import type { UsageStep } from "./constants";

// Calendar days in a time zone, for spending by hour, day, week and month (§6.9). A day is
// "YYYY-MM-DD" and an hour "YYYY-MM-DDTHH", both on the wall clock of the zone asked for, so a run
// at 11pm lands on the day it was made rather than on UTC's. Weeks start on Monday (ISO 8601).
// Everything past the first conversion is plain calendar arithmetic: no zone, no DST.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the runtime knows this IANA zone, such as "Europe/Lisbon". */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** "2026-09-19T23" for an instant, on the zone's wall clock. */
export function localHour(instant: Date | number | string, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instant))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

/** "2026-09-19" for an instant, on the zone's wall clock. */
export function localDay(instant: Date | number | string, timeZone: string): string {
  return localHour(instant, timeZone).slice(0, 10);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function parts(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function fromUtc(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const utcOf = (day: string) => {
  const [y, m, d] = parts(day);
  return Date.UTC(y, m - 1, d);
};

export function addDays(day: string, days: number): string {
  return fromUtc(utcOf(day) + days * 86_400_000);
}

/** Whole days from `a` to `b`: 0 for the same day, 1 for the next. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcOf(b) - utcOf(a)) / 86_400_000);
}

export function addMonths(day: string, months: number): string {
  const [y, m] = parts(day);
  const total = y * 12 + (m - 1) + months;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}-01`;
}

/** Monday 0 through Sunday 6. */
export function weekday(day: string): number {
  return (new Date(utcOf(day)).getUTCDay() + 6) % 7;
}

/** The first day of the bucket a day falls in: itself, its week's Monday, or its month's 1st. */
export function bucketOf(day: string, step: Exclude<UsageStep, "hour">): string {
  if (step === "day") return day;
  if (step === "week") return addDays(day, -weekday(day));
  return `${day.slice(0, 7)}-01`;
}

/** The bucket after this one. Hours count on the wall clock, 00 through 23, whatever DST does. */
export function nextBucket(start: string, step: UsageStep): string {
  if (step === "hour") {
    const hour = Number(start.slice(11, 13));
    return hour < 23 ? `${start.slice(0, 11)}${pad(hour + 1)}` : `${addDays(start.slice(0, 10), 1)}T00`;
  }
  if (step === "day") return addDays(start, 1);
  if (step === "week") return addDays(start, 7);
  return addMonths(start, 1);
}

/** Past this a range is cut short rather than drawn: nobody reads 10,000 bars. */
export const MAX_BUCKETS = 2000;

/**
 * Every bucket from the one holding `first` to the one holding `last`, both included, so days with
 * nothing still show as zero. Hours take "YYYY-MM-DDTHH" keys, the other steps days.
 */
export function bucketsBetween(first: string, last: string, step: UsageStep): string[] {
  const start = step === "hour" ? first.slice(0, 13) : bucketOf(first.slice(0, 10), step);
  const end = step === "hour" ? last.slice(0, 13) : bucketOf(last.slice(0, 10), step);
  const out: string[] = [];
  for (let key = start; key <= end && out.length < MAX_BUCKETS; key = nextBucket(key, step)) out.push(key);
  return out;
}
