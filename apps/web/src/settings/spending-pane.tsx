import { t, type UsageSeriesResponse } from "@openfield/core";
import { Banner, Button, EmptyStateInline, Surface } from "@openfield/ui";
import { Receipt } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { useUsageSeries } from "../api/hooks/usage";
import { errorMessage } from "../api/raw";
import { SpendingChart } from "./spending/chart";
import { Controls } from "./spending/controls";
import { useSeriesLabels } from "./spending/labels";
import { useSpendingPrefs } from "./spending/prefs";
import {
  drillInto,
  pickStep,
  previousRange,
  rangeQuery,
  resolveRange,
  spanQuery,
  todayOf,
  viewerZone,
} from "./spending/range";
import { GroupTable } from "./spending/table";
import { ThisMonth } from "./spending/this-month";
import { type Comparison, Tiles } from "./spending/tiles";
import { buildView, OTHER, type SpendingView } from "./spending/view";

// Settings · Spending (§6.9, design "Settings · Spending · Dashboard"): the dates and how to look at
// them, what they add up to, a chart by model (or company, size, place), the table behind it, and
// this month against the limit.

export function SpendingPane() {
  const prefs = useSpendingPrefs();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const labelOf = useSeriesLabels();
  const today = todayOf();
  const tz = viewerZone();

  // All time starts on the first tracked day, which only an answer can say, so it's remembered.
  const range = resolveRange(prefs.range, today, prefs.firstDay);
  const step = pickStep(prefs.step, range);
  const { groupBy } = prefs;
  const series = useUsageSeries({ ...rangeQuery(range), tz, step, groupBy });
  const before = previousRange(range);
  const previous = useUsageSeries(before ? { ...spanQuery(before), tz, step: "month", groupBy } : null);

  const data = series.data;
  const { learnFirstDay, firstDay } = prefs;
  useEffect(() => {
    if (data && data.firstDay !== firstDay) learnFirstDay(data.firstDay);
  }, [data, firstDay, learnFirstDay]);

  const view = data
    ? buildView(data, { hidden: prefs.hidden[groupBy] ?? [], saved: prefs.slots[groupBy] ?? {} })
    : null;
  const remember = prefs.remember;
  useEffect(() => {
    if (view?.saved) remember(groupBy, view.saved);
  }, [view?.saved, remember, groupBy]);

  const limit = settings.data?.spendGuardUsd ?? null;
  const thisMonth = (
    <ThisMonth
      today={today}
      limit={limit}
      currency={data?.currency ?? "USD"}
      onLimit={(spendGuardUsd) => updateSettings.mutate({ spendGuardUsd })}
    />
  );

  if (series.isError) return <Banner variant="error" message={errorMessage(series.error)} />;
  if (!data || !view) return null;
  if (data.firstDay === null) {
    return (
      <>
        <Surface variant="card" className="items-center px-24 py-56">
          <EmptyStateInline
            icon={Receipt}
            title={t("settings.spending.nothingYet")}
            body={t("settings.spending.nothingYetBody")}
            className="w-360"
            actions={
              <Button asChild variant="ghost" size="s">
                <Link to="/image">{t("settings.spending.makeImage")}</Link>
              </Button>
            }
          />
        </Surface>
        {thisMonth}
      </>
    );
  }

  const { visible } = view;
  const note =
    visible.runs === 0 && visible.images === 0
      ? t("settings.spending.noneInRange")
      : prefs.metric === "spend" && visible.usd === 0 && visible.images > 0
        ? t("settings.spending.noCost")
        : null;
  const comparison: Comparison | null | undefined =
    before === null
      ? null
      : previous.data && !previous.isPlaceholderData
        ? {
            before: visibleSpend(previous.data, view, prefs.hidden[groupBy] ?? []),
            firstEver: data.firstDay >= range.from,
            firstDay: data.firstDay,
          }
        : undefined;
  const models =
    groupBy === "model"
      ? view.series.filter((s) => !s.hidden).reduce((n, s) => n + s.groups.length, 0)
      : data.models;

  return (
    <>
      <Controls
        range={range}
        today={today}
        step={step}
        groupBy={groupBy}
        metric={prefs.metric}
        chart={prefs.chart}
        onRange={(choice) => prefs.set({ range: choice })}
        onStep={(next) => prefs.set({ step: next })}
        onGroupBy={(next) => prefs.set({ groupBy: next })}
        onMetric={(next) => prefs.set({ metric: next })}
        onChart={(next) => prefs.set({ chart: next })}
      />
      <div className="flex w-full flex-col gap-10">
        <Tiles
          range={range}
          figures={visible}
          models={models}
          currency={data.currency}
          comparison={comparison}
        />
        {visible.reruns > 0 ? (
          <p className="text-small text-text-secondary">
            {t("settings.spending.reruns", { count: visible.reruns })}
          </p>
        ) : null}
      </div>
      <SpendingChart
        starts={data.buckets.map((b) => b.start)}
        series={view.series}
        step={data.step}
        metric={prefs.metric}
        kind={prefs.chart}
        currency={data.currency}
        limit={limit}
        loading={series.isPlaceholderData}
        note={note}
        labelOf={labelOf}
        onToggle={(key) => prefs.toggle(groupBy, key)}
        onDrill={(start) => {
          const next = drillInto(start, data.step, today);
          if (next) prefs.set({ range: next.choice, step: next.step });
        }}
      />
      <GroupTable
        groupBy={data.groupBy}
        series={view.series}
        visible={visible}
        metric={prefs.metric}
        currency={data.currency}
        labelOf={labelOf}
      />
      {thisMonth}
    </>
  );
}

/**
 * What the span before spent on the series on show. A group that's its own series now is hidden
 * or shown by its own key; the rest belong to Other.
 */
function visibleSpend(previous: UsageSeriesResponse, view: SpendingView, hidden: readonly string[]): number {
  const own = new Set(view.series.filter((s) => s.key !== OTHER).map((s) => s.key));
  const off = new Set(hidden);
  let sum = 0;
  for (const group of previous.groups) {
    if (off.has(own.has(group.key) ? group.key : OTHER)) continue;
    sum += group.usd;
  }
  return Math.round(sum * 1e6) / 1e6;
}
