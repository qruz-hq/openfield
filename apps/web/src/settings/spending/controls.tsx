import { t, USAGE_SERIES_GROUPS, type UsageGrouping, type UsageStep } from "@openfield/core";
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  SegmentedItem,
  Select,
  SelectItem,
} from "@openfield/ui";
import { ChevronDown } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { focusSelected, Listbox, Option } from "../../lib/listbox";
import type { ChartKind } from "./prefs";
import {
  allowedSteps,
  formatDaySpan,
  RANGE_PRESETS,
  type RangeChoice,
  type RangePreset,
  type ResolvedRange,
} from "./range";
import type { Metric } from "./view";

// Settings > Spending's one row of controls (design Controls): the dates and step on the left,
// scoping everything below; what the chart splits by and how it draws on the right.

const STEPS = ["day", "week", "month"] as const;

export function Controls({
  range,
  today,
  step,
  groupBy,
  metric,
  chart,
  onRange,
  onStep,
  onGroupBy,
  onMetric,
  onChart,
}: {
  range: ResolvedRange;
  today: string;
  step: UsageStep;
  groupBy: UsageGrouping;
  metric: Metric;
  chart: ChartKind;
  onRange: (choice: RangeChoice) => void;
  onStep: (step: UsageStep) => void;
  onGroupBy: (groupBy: UsageGrouping) => void;
  onMetric: (metric: Metric) => void;
  onChart: (chart: ChartKind) => void;
}) {
  const allowed = allowedSteps(range);
  // A single day goes by the hour: Day stays picked, as the day it is.
  const shownStep = step === "hour" ? "day" : step;
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-8">
      <div className="flex items-center gap-8">
        <RangePicker range={range} today={today} onRange={onRange} />
        <Segmented
          aria-label={t("settings.spending.steps.label")}
          value={shownStep}
          onValueChange={(v) => onStep(v as UsageStep)}
          className="w-216"
        >
          {STEPS.map((s) => (
            <SegmentedItem
              key={s}
              value={s}
              disabled={!allowed.includes(s) && !(s === "day" && step === "hour")}
            >
              {t(`settings.spending.steps.${s}`)}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      <div className="flex items-center gap-8">
        <Select
          value={groupBy}
          onValueChange={(v) => onGroupBy(v as UsageGrouping)}
          aria-label={t("settings.spending.groups.label")}
          className="h-36 w-184"
        >
          {USAGE_SERIES_GROUPS.map((g) => (
            <SelectItem key={g} value={g}>
              {t(`settings.spending.groups.${g}`)}
            </SelectItem>
          ))}
        </Select>
        <Segmented
          aria-label={t("settings.spending.metrics.label")}
          value={metric}
          onValueChange={(v) => onMetric(v as Metric)}
          className="w-168"
        >
          <SegmentedItem value="spend">{t("settings.spending.metrics.spend")}</SegmentedItem>
          <SegmentedItem value="images">{t("settings.spending.metrics.images")}</SegmentedItem>
        </Segmented>
        <Segmented
          aria-label={t("settings.spending.charts.label")}
          value={chart}
          onValueChange={(v) => onChart(v as ChartKind)}
          className="w-216"
        >
          <SegmentedItem value="area">{t("settings.spending.charts.area")}</SegmentedItem>
          <SegmentedItem value="lines">{t("settings.spending.charts.lines")}</SegmentedItem>
          <SegmentedItem value="bars">{t("settings.spending.charts.bars")}</SegmentedItem>
        </Segmented>
      </div>
    </div>
  );
}

const presetLabel = (preset: RangePreset) => t(`settings.spending.ranges.${preset}`);

export function rangeLabel(range: ResolvedRange): string {
  return range.choice.kind === "preset"
    ? presetLabel(range.choice.preset)
    : formatDaySpan(range.from, range.to);
}

/**
 * Popover / Spending / Range: presets as rows, then Custom dates behind a hairline, which opens two
 * date fields (design ehUgB, kkLjX).
 */
function RangePicker({
  range,
  today,
  onRange,
}: {
  range: ResolvedRange;
  today: string;
  onRange: (choice: RangeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const custom = range.choice.kind === "custom";
  const [editing, setEditing] = useState(custom);
  const list = useRef<HTMLDivElement>(null);

  const pick = (choice: RangeChoice) => {
    onRange(choice);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setEditing(custom);
      }}
    >
      <PopoverTrigger
        aria-label={t("settings.spending.ranges.label")}
        className="group flex h-36 w-176 cursor-pointer items-center justify-between gap-8 rounded-10 bg-surface px-12 text-small text-text-primary inset-ring inset-ring-border transition-shadow data-[state=open]:inset-ring-accent-line"
      >
        <span className="truncate">{rangeLabel(range)}</span>
        <ChevronDown
          size={14}
          aria-hidden
          className="shrink-0 text-text-tertiary transition-transform group-data-[state=open]:rotate-180"
        />
      </PopoverTrigger>
      <PopoverContent sideOffset={8} className="w-240" onOpenAutoFocus={focusSelected(list)}>
        <div ref={list}>
          <Listbox label={t("settings.spending.ranges.label")} className="flex flex-col gap-2">
            {RANGE_PRESETS.map((preset) => (
              <Option
                key={preset}
                title={presetLabel(preset)}
                selected={!editing && range.choice.kind === "preset" && range.choice.preset === preset}
                onPick={() => pick({ kind: "preset", preset })}
              />
            ))}
            <div className="px-8 py-4">
              <div className="h-px w-full bg-border" />
            </div>
            <Option
              title={t("settings.spending.ranges.custom")}
              selected={custom || editing}
              onPick={() => setEditing(true)}
            />
          </Listbox>
        </div>
        {editing ? (
          <CustomDates
            from={range.from}
            to={range.to}
            today={today}
            onApply={(from, to) => pick({ kind: "custom", from, to })}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CustomDates({
  from,
  to,
  today,
  onApply,
}: {
  from: string;
  to: string;
  today: string;
  onApply: (from: string, to: string) => void;
}) {
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const errorId = useId();
  const invalid = !start || !end || start > end;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!invalid) onApply(start, end);
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-8 p-4">
      <DateRow label={t("settings.spending.ranges.from")} value={start} max={today} onChange={setStart} />
      <DateRow label={t("settings.spending.ranges.to")} value={end} max={today} onChange={setEnd} />
      {start && end && start > end ? (
        <p id={errorId} className="text-caption text-danger">
          {t("settings.spending.ranges.badDates")}
        </p>
      ) : null}
      <Button type="submit" size="s" disabled={invalid} aria-describedby={invalid ? errorId : undefined}>
        {t("settings.spending.ranges.apply")}
      </Button>
    </form>
  );
}

function DateRow({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: string;
  max: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex w-full items-center gap-8">
      <label htmlFor={id} className="w-32 shrink-0 text-caption text-text-tertiary">
        {label}
      </label>
      <Input
        id={id}
        type="date"
        mono
        value={value}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        boxClassName="h-32"
        className="text-mono-12"
      />
    </div>
  );
}
