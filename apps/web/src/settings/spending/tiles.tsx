import {
  formatLocale,
  formatMoney,
  formatNumber,
  formatPrice,
  t,
  tParts,
  type UsageFigures,
} from "@openfield/core";
import { Surface } from "@openfield/ui";
import type { ReactNode } from "react";
import { formatDay, formatDayLong, type ResolvedRange } from "./range";

// Settings > Spending's summary tiles (design Totals, Spending / Stat card): what the dates add up
// to for the series on show.

/** Spending / Stat card: a label, a mono figure, and a line under it with its numbers in mono. */
export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <Surface variant="card" className="min-w-0 flex-1 gap-6">
      <span className="truncate text-caption font-medium text-text-tertiary">{label}</span>
      <span className="truncate text-mono-24 text-text-primary">{value}</span>
      {note ? <span className="text-caption text-text-tertiary">{note}</span> : null}
    </Surface>
  );
}

const mono = (text: string) => <span className="text-mono-12">{text}</span>;

/** A message whose values are numbers set in mono. */
function withNumbers(parts: (string | ReactNode)[]): ReactNode {
  // Fragments of a sentence: their order never changes, so the index is a stable key.
  // biome-ignore lint/suspicious/noArrayIndexKey: see above.
  return parts.map((part, i) => <span key={i}>{part}</span>);
}

export interface Comparison {
  /** Spent in the span before. */
  before: number;
  /** Nothing was tracked before this range started. */
  firstEver: boolean;
  /** The first day anything was tracked. */
  firstDay: string | null;
}

export function Tiles({
  range,
  figures,
  models,
  currency,
  comparison,
}: {
  range: ResolvedRange;
  figures: UsageFigures;
  models: number;
  currency: string;
  /** Null for All time, which has nothing before it. Undefined while it loads. */
  comparison: Comparison | null | undefined;
}) {
  const { choice } = range;
  const today = choice.kind === "preset" && choice.preset === "today";
  const monthly = range.days >= 60;
  const pace = monthly ? figures.usd / (range.days / 30.4375) : figures.usd / range.days;

  return (
    <div className="flex w-full gap-12">
      <StatTile
        label={t("settings.spending.spent")}
        value={formatMoney(figures.usd, currency)}
        note={
          today
            ? t("settings.spending.soFarToday")
            : withNumbers(
                tParts(monthly ? "settings.spending.perMonth" : "settings.spending.perDay", {
                  amount: mono(formatMoney(pace, currency)),
                }),
              )
        }
      />
      <StatTile
        label={t("settings.spending.imagesMade")}
        value={formatNumber(figures.images)}
        note={withNumbers(
          tParts("settings.spending.fromRuns", {
            runs: mono(formatNumber(figures.runs)),
            count: figures.runs,
          }),
        )}
      />
      <StatTile
        label={t("settings.spending.average")}
        value={formatPrice(figures.images > 0 ? figures.usd / figures.images : 0, currency)}
        note={withNumbers(
          tParts("settings.spending.across", { models: mono(formatNumber(models)), count: models }),
        )}
      />
      {comparison === null ? null : (
        <ChangeTile range={range} spent={figures.usd} currency={currency} comparison={comparison} />
      )}
      {figures.usdDiscarded > 0 ? (
        <StatTile
          label={t("settings.spending.canceledCharged")}
          value={formatMoney(figures.usdDiscarded, currency)}
          note={withNumbers(
            tParts("settings.spending.fromCanceled", {
              canceled: mono(formatNumber(figures.canceled)),
              count: figures.canceled,
            }),
          )}
        />
      ) : null}
    </div>
  );
}

function versusLabel(range: ResolvedRange): string {
  const { choice } = range;
  if (choice.kind === "custom") return t("settings.spending.versus.custom", { count: range.days });
  // All time never gets here: it has nothing before it.
  const preset = choice.preset === "all" ? "30d" : choice.preset;
  return t(`settings.spending.versus.${preset}`);
}

function ChangeTile({
  range,
  spent,
  currency,
  comparison,
}: {
  range: ResolvedRange;
  spent: number;
  currency: string;
  comparison: Comparison | undefined;
}) {
  const label = versusLabel(range);
  if (!comparison) return <StatTile label={label} value={<span className="text-text-tertiary">…</span>} />;
  const { before } = comparison;
  if (before <= 0) {
    return (
      <StatTile
        label={label}
        value={t("settings.spending.new")}
        note={
          comparison.firstEver && comparison.firstDay
            ? t("settings.spending.nothingBefore", { date: shortDay(comparison.firstDay, range.to) })
            : t("settings.spending.nothingSpentBefore")
        }
      />
    );
  }
  const change = (spent - before) / before;
  const percent = new Intl.NumberFormat(formatLocale(), {
    style: "percent",
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(change);
  const diff = Math.abs(spent - before);
  const note =
    Math.round(diff * 100) === 0
      ? t("settings.spending.same")
      : withNumbers(
          tParts(spent > before ? "settings.spending.up" : "settings.spending.down", {
            amount: mono(formatMoney(diff, currency)),
            before: mono(formatMoney(before, currency)),
          }),
        );
  return <StatTile label={label} value={percent} note={note} />;
}

/** "Mar 31" this year, "Mar 31, 2025" before it. */
const shortDay = (day: string, today: string) =>
  day.slice(0, 4) === today.slice(0, 4) ? formatDay(day) : formatDayLong(day);
