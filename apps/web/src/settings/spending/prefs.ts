import type { UsageGrouping, UsageStep } from "@openfield/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "../../lib/storage";
import type { RangeChoice } from "./range";
import type { Metric } from "./view";

// How Settings > Spending was last left (§6.9): dates, step, what's charted and how, which series
// are hidden, and the colour each group was given. Kept in localStorage, a per-viewer convenience:
// losing it only resets the view.

export type ChartKind = "area" | "lines" | "bars";

interface SpendingPrefs {
  range: RangeChoice;
  step: UsageStep;
  metric: Metric;
  chart: ChartKind;
  groupBy: UsageGrouping;
  /** Hidden series per grouping, by key. */
  hidden: Partial<Record<UsageGrouping, string[]>>;
  /** The colour slot each group was given, per grouping. */
  slots: Partial<Record<UsageGrouping, Record<string, number>>>;
  /** The first day anything was tracked, as the server last said: where All time starts. */
  firstDay: string | null;
  set: (patch: Partial<Pick<SpendingPrefs, "range" | "step" | "metric" | "chart" | "groupBy">>) => void;
  toggle: (groupBy: UsageGrouping, key: string) => void;
  remember: (groupBy: UsageGrouping, slots: Record<string, number>) => void;
  learnFirstDay: (firstDay: string | null) => void;
  /** What the top nav's Spent today pill opens. */
  showToday: () => void;
}

export const useSpendingPrefs = create<SpendingPrefs>()(
  persist(
    (set) => ({
      range: { kind: "preset", preset: "30d" },
      step: "day",
      metric: "spend",
      chart: "area",
      groupBy: "model",
      hidden: {},
      slots: {},
      firstDay: null,
      set: (patch) => set(patch),
      toggle: (groupBy, key) =>
        set((s) => {
          const current = s.hidden[groupBy] ?? [];
          const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
          return { hidden: { ...s.hidden, [groupBy]: next } };
        }),
      remember: (groupBy, slots) => set((s) => ({ slots: { ...s.slots, [groupBy]: slots } })),
      learnFirstDay: (firstDay) => set({ firstDay }),
      showToday: () => set({ range: { kind: "preset", preset: "today" } }),
    }),
    {
      name: "openfield.spending",
      version: 1,
      storage: safeStorage(),
      partialize: ({ range, step, metric, chart, groupBy, hidden, slots, firstDay }) => ({
        range,
        step,
        metric,
        chart,
        groupBy,
        hidden,
        slots,
        firstDay,
      }),
    },
  ),
);
