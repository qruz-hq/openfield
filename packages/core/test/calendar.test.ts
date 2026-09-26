// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  addDays,
  addMonths,
  bucketOf,
  bucketsBetween,
  daysBetween,
  isTimeZone,
  localDay,
  localHour,
  MAX_BUCKETS,
  nextBucket,
  weekday,
} from "../src/calendar";

describe("the viewer's wall clock", () => {
  test("a late run lands on the day it was made there, not on UTC's", () => {
    // 02:30 UTC on the 20th is still the evening of the 19th in Los Angeles.
    expect(localDay("2026-09-20T02:30:00.000Z", "America/Los_Angeles")).toBe("2026-09-19");
    expect(localDay("2026-09-20T02:30:00.000Z", "UTC")).toBe("2026-09-20");
    expect(localHour("2026-09-20T02:30:00.000Z", "America/Los_Angeles")).toBe("2026-09-19T19");
  });

  test("zones a quarter or half hour off UTC", () => {
    expect(localHour("2026-09-19T18:14:00.000Z", "Asia/Kathmandu")).toBe("2026-09-19T23");
    expect(localHour("2026-09-19T18:15:00.000Z", "Asia/Kathmandu")).toBe("2026-09-20T00");
    expect(localHour("2026-09-19T18:30:00.000Z", "Asia/Kolkata")).toBe("2026-09-20T00");
  });

  test("midnight reads 00, never 24", () => {
    expect(localHour("2026-09-19T00:00:00.000Z", "UTC")).toBe("2026-09-19T00");
  });

  test("knows real zones from made-up ones", () => {
    expect(isTimeZone("Europe/Lisbon")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("calendar arithmetic", () => {
  test("days and months roll over years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-01");
    expect(addMonths("2026-01-31", -1)).toBe("2025-12-01");
    expect(daysBetween("2026-09-01", "2026-09-26")).toBe(25);
  });

  test("weeks start on Monday", () => {
    expect(weekday("2026-09-21")).toBe(0);
    expect(weekday("2026-09-27")).toBe(6);
    expect(bucketOf("2026-09-27", "week")).toBe("2026-09-21");
    expect(bucketOf("2026-09-21", "week")).toBe("2026-09-21");
    expect(bucketOf("2026-09-19", "month")).toBe("2026-09-01");
  });

  test("hours count on the wall clock and wrap into the next day", () => {
    expect(nextBucket("2026-09-19T22", "hour")).toBe("2026-09-19T23");
    expect(nextBucket("2026-09-19T23", "hour")).toBe("2026-09-20T00");
  });
});

describe("buckets between two days", () => {
  test("every day, quiet ones included", () => {
    expect(bucketsBetween("2026-09-28", "2026-10-02", "day")).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
  });

  test("weeks and months take the bucket each end falls in", () => {
    expect(bucketsBetween("2026-08-28", "2026-09-26", "week")).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
    expect(bucketsBetween("2025-10-15", "2026-01-02", "month")).toEqual([
      "2025-10-01",
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
    ]);
  });

  test("a whole day of hours", () => {
    const hours = bucketsBetween("2026-09-19T00", "2026-09-19T23", "hour");
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-09-19T00");
    expect(hours.at(-1)).toBe("2026-09-19T23");
  });

  test("a range too long to draw is cut short instead of hanging", () => {
    expect(bucketsBetween("1970-01-01", "2026-01-01", "day")).toHaveLength(MAX_BUCKETS);
  });
});
