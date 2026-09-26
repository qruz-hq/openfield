import {
  formatMoney,
  formatNumber,
  formatPrice,
  t,
  type UsageFigures,
  type UsageGrouping,
} from "@openfield/core";
import { cn, ProviderLogo, SectionLabel, Surface } from "@openfield/ui";
import { useId } from "react";
import { logoFor } from "../../lib/provider";
import { shares } from "./chart-math";
import type { SeriesLabel } from "./labels";
import { type Metric, type SeriesView, seriesColor } from "./view";

// Settings > Spending's table (design Section · By model, Spending / Table row): every series with
// what it spent, made and cost per image, and its share of what's on show. Hidden series stay
// listed, dimmed, and out of every total. It is also the chart's accessible form.

// Column widths from the design (88, 72, 88, 148), each with the 16px gap before it.
const COLS = { spent: "w-104", images: "w-88", average: "w-104", share: "w-164" } as const;
const numCell = "pl-16 text-right align-middle text-mono-12";
const rowLine = "border-t border-border";

export function GroupTable({
  groupBy,
  series,
  visible,
  metric,
  currency,
  labelOf,
}: {
  groupBy: UsageGrouping;
  series: readonly SeriesView[];
  visible: UsageFigures;
  metric: Metric;
  currency: string;
  labelOf: (s: SeriesView) => SeriesLabel;
}) {
  const id = useId();
  const shown = series.filter((s) => !s.hidden);
  const basis = (f: UsageFigures) => (metric === "spend" ? f.usd : f.images);
  const split = shares(shown.map((s) => basis(s.figures)));
  const percents = new Map(shown.map((s, i) => [s.key, split[i]!]));
  const hasShare = basis(visible) > 0;
  const average = (f: UsageFigures) => (f.images > 0 ? formatPrice(f.usd / f.images, currency) : "");

  return (
    <section aria-labelledby={id} className="flex w-full flex-col gap-10">
      <SectionLabel id={id}>{t(`settings.spending.groups.${groupBy}`)}</SectionLabel>
      <Surface variant="card" className="gap-0 px-16 py-4">
        <table aria-labelledby={id} className="w-full table-fixed border-collapse">
          <thead>
            <tr className="h-36">
              <th scope="col" className="text-left align-middle text-caps text-text-tertiary">
                {t(`settings.spending.columns.${groupBy}`)}
              </th>
              <Head className={COLS.spent}>{t("settings.spending.columns.spent")}</Head>
              <Head className={COLS.images}>{t("settings.spending.columns.images")}</Head>
              <Head className={COLS.average}>{t("settings.spending.columns.average")}</Head>
              <Head className={COLS.share}>{t("settings.spending.columns.share")}</Head>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => {
              const { name, providerId } = labelOf(s);
              const logo = logoFor(providerId);
              const percent = s.hidden || !hasShare ? null : (percents.get(s.key) ?? 0);
              const ink = s.hidden ? "text-text-tertiary" : "text-text-primary";
              return (
                <tr key={s.key} className={cn("h-44", rowLine)}>
                  <th scope="row" className="text-left align-middle font-normal">
                    <span className={cn("flex min-w-0 items-center gap-10", s.hidden && "opacity-45")}>
                      <span
                        aria-hidden
                        className={cn(
                          "size-8 shrink-0 rounded-full",
                          s.hidden && "inset-ring inset-ring-border-strong",
                        )}
                        style={s.hidden ? undefined : { background: seriesColor(s.slot) }}
                      />
                      {logo ? <ProviderLogo provider={logo} /> : null}
                      <span className="truncate text-small text-text-primary">{name}</span>
                    </span>
                  </th>
                  <td className={cn(numCell, ink)}>{formatMoney(s.figures.usd, currency)}</td>
                  <td className={cn(numCell, ink)}>{formatNumber(s.figures.images)}</td>
                  <td className={cn(numCell, ink)}>{average(s.figures)}</td>
                  <td className="pl-16 align-middle">
                    {percent === null ? null : (
                      <span className="flex items-center gap-12">
                        <span
                          aria-hidden
                          className="relative h-4 flex-1 overflow-hidden rounded-full bg-elevated-2"
                        >
                          <span
                            className="absolute inset-y-0 left-0 rounded-full bg-text-secondary"
                            style={{ width: `${percent}%` }}
                          />
                        </span>
                        <span className="w-36 shrink-0 text-right text-mono-12 text-text-secondary">
                          {percent}%
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={cn("h-44", rowLine)}>
              <th scope="row" className="text-left align-middle text-small font-semibold text-text-primary">
                {t("settings.spending.total")}
              </th>
              <td className={cn(numCell, "font-semibold text-text-primary")}>
                {formatMoney(visible.usd, currency)}
              </td>
              <td className={cn(numCell, "font-semibold text-text-primary")}>
                {formatNumber(visible.images)}
              </td>
              <td className={cn(numCell, "font-semibold text-text-primary")}>{average(visible)}</td>
              <td className={cn(numCell, "text-text-secondary")}>{hasShare ? "100%" : ""}</td>
            </tr>
          </tfoot>
        </table>
      </Surface>
    </section>
  );
}

function Head({ className, children }: { className: string; children: string }) {
  return (
    <th scope="col" className={cn("pl-16 text-right align-middle text-caps text-text-tertiary", className)}>
      {children}
    </th>
  );
}
