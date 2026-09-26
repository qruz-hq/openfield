import { formatMoney, t } from "@openfield/core";
import { Button, cn, Input, SettingText } from "@openfield/ui";
import { type FormEvent, useId, useState } from "react";
import { useSpentThisMonth } from "../../api/hooks/usage";
import { SettingRow, SettingsSection } from "../section";
import { monthProjection } from "./chart-math";
import { formatDay } from "./range";

// Settings > Spending · This month (design Section · This month, Spending / This month): what the
// month has cost so far against the limit, a guess at its end, and the limit itself. The figure
// counts canceled-but-charged work too, since that's what the limit is checked against (§6.9).

export function ThisMonth({
  today,
  limit,
  currency,
  onLimit,
}: {
  today: string;
  limit: number | null;
  currency: string;
  onLimit: (limit: number | null) => void;
}) {
  const spent = useSpentThisMonth();
  const [editing, setEditing] = useState(false);

  return (
    <SettingsSection label={t("settings.spending.thisMonth")}>
      {spent.data !== undefined ? (
        <MonthRow key="spent" spent={spent.data} today={today} limit={limit} currency={currency} />
      ) : null}
      {editing ? (
        <LimitEditor
          key="limit"
          limit={limit}
          onSave={(next) => {
            onLimit(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <SettingRow
          key="limit"
          title={t("settings.spending.limit")}
          description={
            limit === null
              ? t("settings.spending.limitOff")
              : t("settings.spending.limitOn", { amount: formatMoney(limit, currency) })
          }
        >
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {limit === null ? t("settings.spending.setLimit") : t("settings.spending.changeLimit")}
          </Button>
        </SettingRow>
      )}
    </SettingsSection>
  );
}

function MonthRow({
  spent,
  today,
  limit,
  currency,
}: {
  spent: number;
  today: string;
  limit: number | null;
  currency: string;
}) {
  const over = limit !== null && spent > limit;
  const guess = monthProjection(spent, today);
  const description = over
    ? t("settings.spending.overLimit")
    : guess
      ? t("settings.spending.onPace", {
          amount: formatMoney(guess.amount, currency),
          date: formatDay(guess.lastDay),
        })
      : undefined;
  const share = (v: number) => `${Math.min(100, (v / (limit ?? 1)) * 100)}%`;

  return (
    <div className="flex w-full flex-col gap-12 py-12">
      <div className="flex w-full items-end justify-between gap-16">
        <SettingText
          title={t("settings.spending.spentThisMonth")}
          description={description}
          className="flex-1"
        />
        <span className="flex shrink-0 items-baseline gap-6">
          <span className="font-mono text-[14px] leading-[17px] font-medium text-text-primary">
            {formatMoney(spent, currency)}
          </span>
          {limit !== null ? (
            <>
              <span className="text-caption text-text-tertiary">{t("settings.spending.ofLimit")}</span>
              <span className="text-mono-12 text-text-tertiary">{formatMoney(limit, currency)}</span>
            </>
          ) : null}
        </span>
      </div>
      {limit !== null ? (
        <div
          role="progressbar"
          aria-label={t("settings.spending.spentThisMonth")}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(spent, limit)}
          aria-valuetext={`${formatMoney(spent, currency)} ${t("settings.spending.ofLimit")} ${formatMoney(limit, currency)}`}
          className="relative h-6 w-full overflow-hidden rounded-full bg-elevated-2"
        >
          {guess && !over ? (
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-accent-line"
              style={{ width: share(guess.amount) }}
            />
          ) : null}
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-danger" : "bg-accent")}
            style={{ width: share(spent) }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Spending / Limit card, inline: an amount in dollars, then Turn off, Cancel and Save. */
function LimitEditor({
  limit,
  onSave,
  onCancel,
}: {
  limit: number | null;
  onSave: (limit: number | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(limit === null ? "" : limit.toFixed(2));
  const [tried, setTried] = useState(false);
  const errorId = useId();
  const parsed = Number(value.trim().replace(",", "."));
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (valid) onSave(Math.round(parsed * 100) / 100);
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-10 py-12">
      <SettingText title={t("settings.spending.limit")} />
      <div className="flex w-full flex-wrap items-center gap-8">
        <Input
          mono
          leading="$"
          inputMode="decimal"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={t("settings.spending.limitAmount")}
          aria-invalid={tried && !valid}
          aria-describedby={tried && !valid ? errorId : undefined}
          boxClassName="w-140"
        />
        <span className="text-small text-text-secondary">{t("settings.spending.aMonth")}</span>
        <div className="ml-auto flex items-center gap-8">
          {limit !== null ? (
            <Button type="button" variant="ghost" onClick={() => onSave(null)}>
              {t("settings.spending.turnOff")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("actions.cancel")}
          </Button>
          <Button type="submit">{t("actions.save")}</Button>
        </div>
      </div>
      {tried && !valid ? (
        <p id={errorId} className="text-caption text-danger">
          {t("settings.spending.limitInvalid")}
        </p>
      ) : null}
    </form>
  );
}
