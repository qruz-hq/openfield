import { formatDate, t } from "@openfield/core";
import { useEffect, useState } from "react";

// "Edited 10 min ago" on the index cards: relative under 7 days, then the date in the person's
// locale (§7.3).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Calendar days between two instants in local time, so "yesterday" means yesterday. */
function calendarDays(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end.getTime() - start.getTime()) / DAY);
}

export function editedLabel(updatedAt: string, now: number = Date.now()): string {
  const at = new Date(updatedAt);
  // A clock a little ahead of the server's still reads as now.
  const elapsed = Math.max(0, now - at.getTime());
  if (elapsed < MINUTE) return t("canvas.index.edited.now");
  if (elapsed < HOUR) return t("canvas.index.edited.minutes", { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t("canvas.index.edited.hours", { count: Math.floor(elapsed / HOUR) });
  const days = calendarDays(at, new Date(now));
  if (days <= 1) return t("canvas.index.edited.yesterday");
  if (days < 7) return t("canvas.index.edited.days", { count: days });
  return t("canvas.index.edited.date", { date: formatDate(at) });
}

/** The current time, ticking once a minute, so relative labels don't go stale on an open page. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  return now;
}
