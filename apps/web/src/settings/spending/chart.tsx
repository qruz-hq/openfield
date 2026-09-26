import { formatMoney, formatNumber, t, type UsageStep } from "@openfield/core";
import { cn, Surface } from "@openfield/ui";
import { Info } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  axisIndices,
  bandPath,
  barLayout,
  bucketXs,
  linePath,
  nearestIndex,
  niceScale,
  PLOT,
  type Point,
  stack,
} from "./chart-math";
import type { SeriesLabel } from "./labels";
import type { ChartKind } from "./prefs";
import { axisLabel, bucketTitle } from "./range";
import { type Metric, type SeriesView, seriesColor, valuesOf } from "./view";

// Settings > Spending's chart card (design Chart): title and legend, then the plot. Stacked areas,
// a line per series, or stacked bars; hover or arrow keys show every series at one bucket, and a
// week or month opens its days or weeks on click. The table below carries every number, so the
// chart never has to.

// The first series is the accent, a pale fill; the soft hues read at a little more (design washes).
const washOf = (slot: number) => (slot === 0 ? 0.09 : 0.12);

/** Room each x label needs: dates are about 5 days apart as in the design, months side by side. */
const LABEL_ROOM: Record<UsageStep, number> = { hour: 110, day: 150, week: 90, month: 80 };

export function SpendingChart({
  starts,
  series,
  step,
  metric,
  kind,
  currency,
  limit,
  loading,
  note,
  labelOf,
  onToggle,
  onDrill,
}: {
  /** Bucket starts, oldest first. */
  starts: readonly string[];
  /** Every series, hidden ones included (the legend shows them). */
  series: readonly SeriesView[];
  step: UsageStep;
  metric: Metric;
  kind: ChartKind;
  currency: string;
  /** The monthly limit, drawn on the Month step when it's set. */
  limit: number | null;
  /** New dates are on their way: keep the frame, dim it. */
  loading: boolean;
  note: ReactNode;
  labelOf: (s: SeriesView) => SeriesLabel;
  onToggle: (key: string) => void;
  onDrill: (start: string) => void;
}) {
  const title = t("settings.spending.chartTitle", { metric, step });
  return (
    <Surface
      variant="card"
      className={cn("gap-16 px-20 pt-20 pb-16 transition-opacity", loading && "opacity-60")}
    >
      <div className="flex w-full flex-wrap items-center justify-between gap-x-16 gap-y-8">
        <div className="flex min-w-0 flex-col gap-4">
          <h3 className="text-body-medium text-text-primary">{title}</h3>
          {note ? (
            <p className="flex items-center gap-6 text-caption text-text-tertiary">
              <Info size={14} aria-hidden className="shrink-0" />
              {note}
            </p>
          ) : null}
        </div>
        <Legend series={series} kind={kind} labelOf={labelOf} onToggle={onToggle} />
      </div>
      <Plot
        title={title}
        starts={starts}
        series={series.filter((s) => !s.hidden)}
        step={step}
        metric={metric}
        kind={kind}
        currency={currency}
        limit={metric === "spend" && step === "month" ? limit : null}
        labelOf={labelOf}
        onDrill={onDrill}
      />
    </Surface>
  );
}

/** Spending / Legend item / On and / Off: a toggle per series. */
function Legend({
  series,
  kind,
  labelOf,
  onToggle,
}: {
  series: readonly SeriesView[];
  kind: ChartKind;
  labelOf: (s: SeriesView) => SeriesLabel;
  onToggle: (key: string) => void;
}) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-4">
      {series.map((s) => {
        const { name } = labelOf(s);
        return (
          <li key={s.key}>
            <button
              type="button"
              aria-pressed={!s.hidden}
              aria-label={t(s.hidden ? "settings.spending.show" : "settings.spending.hide", { name })}
              onClick={() => onToggle(s.key)}
              className="flex h-28 cursor-pointer items-center gap-8 rounded-8 px-8 transition-colors hover:bg-elevated-2"
            >
              <span
                aria-hidden
                className={cn(
                  "shrink-0",
                  kind === "lines" ? "h-2 w-10 rounded-[1px]" : "size-10 rounded-[3px]",
                  s.hidden && "inset-ring inset-ring-border-strong",
                )}
                style={s.hidden ? undefined : { background: seriesColor(s.slot) }}
              />
              <span
                className={cn(
                  "whitespace-nowrap text-caption font-medium",
                  s.hidden ? "text-text-tertiary" : "text-text-secondary",
                )}
              >
                {name}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Rounded top corners only: a bar grows from the baseline and ends in a 4px curve. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function Plot({
  title,
  starts,
  series,
  step,
  metric,
  kind,
  currency,
  limit,
  labelOf,
  onDrill,
}: {
  title: string;
  starts: readonly string[];
  series: readonly SeriesView[];
  step: UsageStep;
  metric: Metric;
  kind: ChartKind;
  currency: string;
  limit: number | null;
  labelOf: (s: SeriesView) => SeriesLabel;
  onDrill: (start: string) => void;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const count = starts.length;
  const values = series.map((s) => valuesOf(s, metric));
  const tops = stack(values);
  const highest = kind === "lines" ? Math.max(0, ...values.flat()) : Math.max(0, ...(tops.at(-1) ?? []));
  const scale = niceScale(Math.max(highest, limit ?? 0), metric === "images");
  const y = (v: number) => PLOT.base - (v / scale.max) * (PLOT.base - PLOT.top);
  const bars = kind === "bars" ? barLayout(count, width) : null;
  const xs = bars ? bars.centers : bucketXs(count, width);
  const drillable = step === "week" || step === "month";
  const format = (v: number) => (metric === "spend" ? formatMoney(v, currency) : formatNumber(v));
  const at = hover !== null && hover < count ? hover : null;

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!count) return;
    const box = event.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(event.clientX - box.left, xs));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    const current = at ?? count - 1;
    const next =
      event.key === "ArrowRight"
        ? Math.min(count - 1, current + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, current - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      setHover(next);
    } else if ((event.key === "Enter" || event.key === " ") && drillable && at !== null) {
      event.preventDefault();
      onDrill(starts[at]!);
    }
  };

  // Every k-th day gets a label, so they never touch; the last one always does.
  const spacing = count > 1 ? xs[1]! - xs[0]! : width;
  const labelled = axisIndices(count, Math.ceil(LABEL_ROOM[step] / Math.max(spacing, 1)), !bars);

  return (
    // A chart, not a form, so a group rather than a fieldset. Focusable because the arrow keys walk
    // the buckets the way hovering does.
    // biome-ignore lint/a11y/useSemanticElements: see above.
    <div
      ref={ref}
      role="group"
      aria-label={t("settings.spending.chartLabel", { title })}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: see above.
      tabIndex={0}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
      onFocus={() => setHover((h) => h ?? (count ? count - 1 : null))}
      onBlur={() => setHover(null)}
      onKeyDown={onKeyDown}
      onClick={() => drillable && at !== null && onDrill(starts[at]!)}
      className={cn("relative w-full rounded-8", drillable && at !== null && "cursor-pointer")}
      style={{ height: PLOT.height }}
    >
      {width > 0 ? (
        <svg width={width} height={PLOT.height} aria-hidden className="block overflow-visible">
          {scale.ticks.map((v) => (
            <g key={v}>
              <rect
                x={PLOT.gridLeft}
                y={Math.round(y(v))}
                width={width - PLOT.gridLeft}
                height={1}
                style={{ fill: v === 0 ? "var(--of-border-strong)" : "var(--of-border)" }}
              />
              <text
                x={40}
                y={Math.round(y(v))}
                dominantBaseline="middle"
                textAnchor="end"
                className="text-mono-11"
                style={{ fill: "var(--of-text-tertiary)" }}
              >
                {metric === "spend" ? tickMoney(v, currency) : formatNumber(v)}
              </text>
            </g>
          ))}

          {bars && at !== null ? (
            <rect
              x={xs[at]! - bars.slot / 2 + 8}
              y={PLOT.top}
              width={Math.max(bars.slot - 16, bars.bar + 8)}
              height={PLOT.base - PLOT.top}
              rx={8}
              style={{ fill: "var(--of-text-primary)", fillOpacity: 0.03 }}
            />
          ) : null}

          {kind === "area"
            ? series.map((s, k) => {
                const upper: Point[] = xs.map((x, i) => [x, y(tops[k]![i]!)]);
                const lower: Point[] = xs.map((x, i) => [x, y(k === 0 ? 0 : tops[k - 1]![i]!)]);
                return (
                  <path
                    key={`band-${s.key}`}
                    d={bandPath(upper, lower)}
                    style={{ fill: seriesColor(s.slot), fillOpacity: washOf(s.slot) }}
                  />
                );
              })
            : null}
          {kind === "area" || kind === "lines"
            ? series.map((s, k) => {
                const line = kind === "area" ? tops[k]! : values[k]!;
                return (
                  <path
                    key={`line-${s.key}`}
                    d={linePath(xs.map((x, i) => [x, y(line[i]!)]))}
                    style={{ fill: "none", stroke: seriesColor(s.slot) }}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })
            : null}
          {bars
            ? xs.map((x, i) => {
                const segments = series
                  .map((s, k) => ({ s, from: k === 0 ? 0 : tops[k - 1]![i]!, to: tops[k]![i]! }))
                  .filter((seg) => seg.to > seg.from);
                return segments.map((seg, j) => {
                  const top = y(seg.to);
                  // A 2px gap in the card's own colour between segments, never a stroke.
                  const bottom = j === 0 ? y(seg.from) : y(seg.from) - PLOT.barGap;
                  const h = bottom - top;
                  if (h <= 0) return null;
                  const left = x - bars.bar / 2;
                  const last = j === segments.length - 1;
                  return (
                    <path
                      key={`${starts[i]}-${seg.s.key}`}
                      d={
                        last
                          ? roundedTop(left, top, bars.bar, h, PLOT.barRadius)
                          : `M${left},${top} h${bars.bar} v${h} h${-bars.bar} Z`
                      }
                      style={{ fill: seriesColor(seg.s.slot) }}
                    />
                  );
                });
              })
            : null}

          {limit !== null ? <LimitLine y={Math.round(y(limit)) + 0.5} width={width} /> : null}

          {!bars && at !== null ? (
            <>
              <rect
                x={Math.round(xs[at]!)}
                y={PLOT.top}
                width={1}
                height={PLOT.base - PLOT.top}
                style={{ fill: "var(--of-border-strong)" }}
              />
              {series.map((s, k) => {
                const v = kind === "area" ? tops[k]![at]! : values[k]![at]!;
                if ((values[k]![at] ?? 0) <= 0) return null;
                return (
                  <circle
                    key={`dot-${s.key}`}
                    cx={xs[at]}
                    cy={y(v)}
                    r={4}
                    strokeWidth={2}
                    style={{ fill: seriesColor(s.slot), stroke: "var(--of-elevated)" }}
                  />
                );
              })}
            </>
          ) : null}

          {labelled.map((i) => {
            const last = !bars && i === count - 1 && count > 1;
            return (
              <text
                key={`x-${starts[i]}`}
                x={last ? width : xs[i]}
                y={PLOT.labelY}
                dominantBaseline="hanging"
                textAnchor={last ? "end" : "middle"}
                className="text-mono-11"
                style={{ fill: "var(--of-text-tertiary)" }}
              >
                {axisLabel(starts[i]!, step, i === 0)}
              </text>
            );
          })}
        </svg>
      ) : null}

      {limit !== null && width > 0 ? (
        <div
          aria-hidden
          // The card's own colour behind it, so it stays readable where a bar crosses the line.
          className="pointer-events-none absolute right-0 flex items-center gap-4 rounded-4 bg-elevated px-4 text-micro text-text-secondary"
          style={{ top: Math.round(y(limit)) - 18 }}
        >
          <span>{t("settings.spending.monthLimit")}</span>
          <span className="text-mono-11">{formatMoney(limit, currency).replace(/\.00$/, "")}</span>
        </div>
      ) : null}

      {at !== null && width > 0 ? (
        <Tooltip
          title={bucketTitle(starts[at]!, step)}
          rows={[...series].map((s, k) => ({ s, v: values[k]![at]!, images: s.images[at]! })).reverse()}
          format={format}
          metric={metric}
          labelOf={labelOf}
          hint={
            drillable
              ? t(step === "month" ? "settings.spending.drillWeeks" : "settings.spending.drillDays")
              : null
          }
          x={xs[at]!}
          reach={bars ? bars.slot / 2 - 4 : 12}
          width={width}
        />
      ) : null}
    </div>
  );
}

/** "$0.25" on the axis, "$5" once ticks are whole dollars. */
function tickMoney(v: number, currency: string): string {
  if (v === 0) return formatMoney(0, currency).replace(/[.,]00$/, "");
  const text = formatMoney(v, currency);
  return Number.isInteger(v) ? text.replace(/[.,]00$/, "") : text;
}

function LimitLine({ y, width }: { y: number; width: number }) {
  return (
    <line
      x1={PLOT.gridLeft}
      x2={width}
      y1={y}
      y2={y}
      strokeWidth={1}
      strokeDasharray="6 4"
      style={{ stroke: "var(--of-text-secondary)" }}
    />
  );
}

const TOOLTIP_WIDTH = 216;

/** Spending / Chart tooltip: every series on show at one bucket, top of the stack first. */
function Tooltip({
  title,
  rows,
  format,
  metric,
  labelOf,
  hint,
  x,
  reach,
  width,
}: {
  title: string;
  rows: { s: SeriesView; v: number; images: number }[];
  format: (v: number) => string;
  metric: Metric;
  labelOf: (s: SeriesView) => SeriesLabel;
  hint: string | null;
  x: number;
  /** How far from the bucket's centre the tooltip starts. */
  reach: number;
  width: number;
}) {
  const total = rows.reduce((sum, r) => sum + r.v, 0);
  const images = rows.reduce((sum, r) => sum + r.images, 0);
  // Right of the bucket when it fits, else left of it.
  const right = x + reach + TOOLTIP_WIDTH <= width;
  const style = right ? { left: x + reach } : { right: width - x + reach };
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute top-12 z-10 flex min-w-216 max-w-320 flex-col gap-8 rounded-10 bg-elevated-2 px-12 py-10 inset-ring inset-ring-border shadow-popover"
      style={style}
    >
      <p className="text-caption font-semibold text-text-primary">{title}</p>
      <ul className="flex flex-col gap-6">
        {rows.map(({ s, v }) => {
          const { name } = labelOf(s);
          return (
            <li key={s.key} className="flex items-center gap-8">
              <span
                aria-hidden
                className="h-2 w-10 shrink-0 rounded-[1px]"
                style={{ background: seriesColor(s.slot) }}
              />
              <span className="min-w-48 text-mono-12 font-medium text-text-primary">{format(v)}</span>
              <span className="truncate text-caption text-text-secondary">{name}</span>
            </li>
          );
        })}
      </ul>
      <div className="h-px w-full bg-border" />
      <p className="flex items-center gap-8">
        <span aria-hidden className="w-10 shrink-0" />
        <span className="min-w-48 text-mono-12 font-semibold text-text-primary">{format(total)}</span>
        <span className="text-caption text-text-secondary">
          {metric === "spend"
            ? t("settings.spending.tooltipTotal", { count: images })
            : t("settings.spending.total")}
        </span>
      </p>
      {hint ? <p className="text-micro text-text-tertiary">{hint}</p> : null}
    </div>
  );
}
