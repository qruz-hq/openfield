import {
  DEFAULT_CURRENCY,
  formatLocale,
  formatPrice,
  LIMITS_PANEL_ID,
  type ModelManifest,
  type PriceModel,
  type ProviderSettingsResponse,
  type SettingCondition,
  type SettingField,
  type SettingOption,
  type SettingsPanel,
  type SettingValue,
  type SpeedId,
  t,
} from "@openfield/core";
import {
  conditionHolds,
  estimate,
  modelsOffering,
  modelsUsing,
  priceFor,
  resolveSpeed,
  settingShown,
  speedOffer,
} from "@openfield/providers/manifest";

// Pure logic behind a company's settings modal, its key card and the prices that follow its
// speed. No React here, so it's unit tested. The modal draws only what GET /settings returns.

export const isSpeedField = (field: SettingField) => field.kind === "select" && field.role === "speed";
export const isLimitsPanel = (panel: Pick<SettingsPanel, "id">) => panel.id === LIMITS_PANEL_ID;

/** Every per-image amount a price can come to, for the range on an option card. */
function amounts(price: PriceModel, manifest: ModelManifest, speed: SpeedId): number[] {
  if (price.kind === "per_image") return price.tiers.map((tier) => tier.usd);
  const cost = estimate(manifest, { batch: 1, speed });
  return cost.confidence === "unknown" ? [] : [cost.min, cost.max];
}

export interface PriceRange {
  min: number;
  max: number;
  currency: string;
}

/**
 * Lowest to highest price per image of an option, across the company's models it matters for. A
 * speed option prices at its speed; another option only when it names the speed it bills at
 * ("Switch to Standard"). Other options don't change what a run costs.
 */
export function optionPriceRange(
  field: SettingField,
  option: SettingOption,
  manifests: readonly ModelManifest[],
  speedFieldId?: string,
): PriceRange | undefined {
  const speed = isSpeedField(field) ? (option.value as SpeedId) : option.priceAt;
  if (!speed) return undefined;
  const priced = isSpeedField(field)
    ? modelsOffering(field, option, manifests)
    : modelsUsing(field, speedFieldId, manifests).filter((m) => !resolveSpeed(m, speed).fellBack);
  const all = priced.flatMap((m) => amounts(priceFor(m, speed), m, speed));
  if (!all.length) return undefined;
  const first = priceFor(priced[0]!, speed);
  const currency = "currency" in first ? first.currency : DEFAULT_CURRENCY;
  return { min: Math.min(...all), max: Math.max(...all), currency };
}

/** "$0.034–0.24", or one amount when both ends read the same. */
export function formatPriceRange({ min, max, currency }: PriceRange): string {
  const high = formatPrice(max, currency, false);
  return formatPrice(min, currency, false) === high
    ? formatPrice(min, currency)
    : t("cost.range", { min: formatPrice(min, currency), max: high });
}

const list = (items: string[], type: Intl.ListFormatType = "conjunction") =>
  new Intl.ListFormat(formatLocale(), { style: "long", type }).format(items);

/** "Nano Banana Pro only" when only some of the company's models offer an option. */
export function optionAvailability(
  field: SettingField,
  option: SettingOption,
  manifests: readonly ModelManifest[],
): string | undefined {
  const applies = manifests.filter((m) => !field.models || field.models.includes(m.key));
  const offering = modelsOffering(field, option, manifests);
  if (!offering.length || offering.length === applies.length) return undefined;
  return t("providerSettings.modelsOnly", { models: list(offering.map((m) => m.displayName)) });
}

/** "Nano Banana Pro only" for a field that applies to some of the company's models. */
export function fieldAvailability(
  field: SettingField,
  manifests: readonly ModelManifest[],
): string | undefined {
  if (!field.models) return undefined;
  const applies = manifests.filter((m) => field.models?.includes(m.key));
  if (!applies.length || applies.length === manifests.length) return undefined;
  return t("providerSettings.modelsOnly", { models: list(applies.map((m) => m.displayName)) });
}

/** How a value reads to a person: an option's label, On or Off, or the number itself. */
export function valueLabel(field: SettingField, value: SettingValue | undefined): string {
  if (value === undefined) return "";
  switch (field.kind) {
    case "select":
      return field.options.find((o) => o.value === value)?.label ?? String(value);
    case "toggle":
      return t(value ? "providerSettings.on" : "providerSettings.off");
    default:
      return String(value);
  }
}

export interface Summary {
  fieldId: string;
  /** The field's name, for screen readers ("Speed"), when the label is only its value. */
  field?: string;
  label: string;
  speed: boolean;
}

/** One pill per company choice that isn't its default, value only ("Batch"). */
export function settingSummaries(settings: ProviderSettingsResponse | undefined): Summary[] {
  if (!settings) return [];
  const out: Summary[] = [];
  for (const panel of settings.schema.panels) {
    if (isLimitsPanel(panel)) continue;
    for (const field of panel.fields) {
      const value = settings.values[field.id];
      if (value === undefined || value === field.default || !settingShown(field, settings.values)) continue;
      if (field.kind === "select") {
        out.push({
          fieldId: field.id,
          field: field.label,
          label: valueLabel(field, value),
          speed: isSpeedField(field),
        });
      } else if (field.kind === "toggle" && value === true) {
        out.push({ fieldId: field.id, label: field.label, speed: false });
      }
    }
  }
  return out;
}

export interface Blocked {
  condition: SettingCondition;
  /** The field the condition reads. */
  target: SettingField;
  /** The panel that holds it, for the note's jump. */
  targetPanel: string;
}

export type FieldView =
  | { mode: "shown" }
  /** Its condition reads a field right above it, so it simply isn't there. */
  | { mode: "hidden" }
  /** Its condition reads a field in another panel: shown muted, with a note that jumps there. */
  | { mode: "muted"; blocked: Blocked };

/** How the modal shows a field whose "show when" may not hold right now. */
export function fieldView(
  field: SettingField,
  panelId: string,
  panels: readonly SettingsPanel[],
  values: Readonly<Record<string, SettingValue>>,
): FieldView {
  if (settingShown(field, values)) return { mode: "shown" };
  for (const condition of field.showWhen ?? []) {
    if (conditionHolds(condition, values)) continue;
    const targetPanel = panels.find((p) => p.fields.some((f) => f.id === condition.field));
    const target = targetPanel?.fields.find((f) => f.id === condition.field);
    if (targetPanel && target && targetPanel.id !== panelId) {
      return { mode: "muted", blocked: { condition, target, targetPanel: targetPanel.id } };
    }
  }
  return { mode: "hidden" };
}

const lower = (text: string) => text.toLocaleLowerCase(formatLocale());

/** "Only used when Speed is Flex. Your speed is Batch." and "Change speed". */
export function dependencyNote(
  blocked: Blocked,
  values: Readonly<Record<string, SettingValue>>,
): { message: string; action: string } {
  const { condition, target } = blocked;
  const wanted = list(
    ("in" in condition ? condition.in : condition.notIn).map((v) => valueLabel(target, v)),
    "disjunction",
  );
  const rule = t("in" in condition ? "providerSettings.onlyWhen" : "providerSettings.notWhen", {
    field: target.label,
    values: wanted,
  });
  const now = t("providerSettings.currentValue", {
    field: lower(target.label),
    value: valueLabel(target, values[target.id]),
  });
  return { message: `${rule} ${now}`, action: t("providerSettings.change", { field: lower(target.label) }) };
}

/** Days a Batch run may wait at the company before it stops, for the note under the speed field. */
export function batchExpiryDays(manifests: readonly Pick<ModelManifest, "speeds">[]): number | undefined {
  const waits = manifests.flatMap((m) => {
    const offer = speedOffer(m, "batch");
    return offer?.delivery === "async" ? [offer.waitMs.max] : [];
  });
  return waits.length ? Math.max(1, Math.round(Math.max(...waits) / 86_400_000)) : undefined;
}

/** Whether a speed option's runs arrive later, from a provider batch. */
export function isAsyncSpeed(value: string, manifests: readonly Pick<ModelManifest, "speeds">[]): boolean {
  return value !== "standard" && manifests.some((m) => speedOffer(m, value as SpeedId)?.delivery === "async");
}
