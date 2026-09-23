import { DEFAULT_CURRENCY, type ErrorCode } from "../constants";
import { formatLocale, numberFormat } from "./locale";
import { t } from "./messages";

// Numbers, money and dates go through Intl with the person's own locale (§2.12).
// Cost wording follows §0.15: "About $0.16", "About $0.12–0.19", "~$0.16", "Cost unknown", "Free".

/**
 * "$0.13". `precise` keeps a third decimal for billed amounts ("$0.134"). The narrow symbol keeps
 * "$" in every English locale (en-GB would otherwise say "US$").
 */
export function formatMoney(amount: number, currency = DEFAULT_CURRENCY, precise = false): string {
  return numberFormat({
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: precise ? 3 : 2,
  }).format(amount);
}

/** Only the digits, for the upper end of a range ("0.19"). */
function formatAmount(amount: number): string {
  return numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

interface CostLike {
  currency: string;
  min: number;
  max: number;
  confidence: "exact" | "estimated" | "unknown";
}

export type CostParts =
  | { kind: "unknown" | "free"; text: string }
  | { kind: "amount"; amount: string; range: boolean };

/**
 * The amount on its own ("$0.16", "$0.12–0.19"), so a caller can set it in mono and the words
 * around it in the body font (§0.15). A range whose ends round to the same cents is one amount.
 */
export function costParts(estimate: CostLike): CostParts {
  if (estimate.confidence === "unknown") return { kind: "unknown", text: t("cost.unknown") };
  if (estimate.max === 0) return { kind: "free", text: t("cost.free") };
  const min = formatMoney(estimate.min, estimate.currency);
  if (formatAmount(estimate.min) === formatAmount(estimate.max)) {
    return { kind: "amount", amount: min, range: false };
  }
  return { kind: "amount", amount: t("cost.range", { min, max: formatAmount(estimate.max) }), range: true };
}

/** The words around an estimate. `tight` is for chips, node pills and table cells. */
export function formatCost(estimate: CostLike, opts: { tight?: boolean } = {}): string {
  const parts = costParts(estimate);
  if (parts.kind !== "amount") return parts.text;
  return t(opts.tight ? "cost.tight" : "cost.about", { cost: parts.amount });
}

/** "About $0.27 · 2 images", the Generate sub-label. */
export function formatCostWithCount(estimate: CostLike, count: number): string {
  return t("cost.withCount", { cost: formatCost(estimate), count });
}

/** "Sep 23, 2026" in the person's locale. Never ISO. */
export function formatDate(value: string | number | Date): string {
  return new Intl.DateTimeFormat(formatLocale(), { dateStyle: "medium" }).format(new Date(value));
}

export function formatDateTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat(formatLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function formatNumber(value: number): string {
  return numberFormat({}).format(value);
}

const BYTE_UNITS = ["kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** "4.2 GB". Decimal units, like the operating system shows; never smaller than kB. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes) / 1000;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return numberFormat({
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

/** The failed-tile reason and button label for an error code (§0.5). */
export function errorCopy(code: ErrorCode): { reason: string; action: string } {
  return { reason: t(`errors.${code}.reason`), action: t(`errors.${code}.action`) };
}
