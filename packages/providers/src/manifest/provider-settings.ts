import {
  type AdapterOp,
  CONCURRENCY_CAP_FIELD,
  isLegalSettingValue,
  LIMITS_PANEL_ID,
  type ModelManifest,
  type ProviderSettingsSchema,
  type ResolvedProviderSettings,
  type SettingCondition,
  type SettingField,
  type SettingNote,
  type SettingOption,
  type SettingValue,
  type SpeedId,
  settingFields,
} from "@openfield/core";
import { resolveSpeed } from "./speed";

// Company settings (§0.3), resolved for one model. Pure and browser-safe: normalize() freezes the
// result onto the request, and the composer runs the same code over GET /settings to price a run.

type Stored = Readonly<Record<string, unknown>> | null | undefined;
type Model = Pick<ModelManifest, "key" | "speeds">;

/** The adapter's own fields, in declared order. Openfield's Limits panel never reaches an adapter. */
function adapterFields(schema: ProviderSettingsSchema | undefined): SettingField[] {
  return settingFields(schema && { panels: schema.panels.filter((p) => p.id !== LIMITS_PANEL_ID) });
}

/** Whether one "show when" condition holds against `values`. */
export function conditionHolds(
  condition: SettingCondition,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const value = values[condition.field] as SettingValue | undefined;
  const listed = value !== undefined && ("in" in condition ? condition.in : condition.notIn).includes(value);
  return "in" in condition ? listed : !listed;
}

/** Whether every condition holds against values resolved so far. */
export function settingShown(
  field: Pick<SettingField, "showWhen">,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return (field.showWhen ?? []).every((c) => conditionHolds(c, values));
}

/** Every field's current value: stored values that still fit, defaults for the rest. */
export function settingValues(
  schema: ProviderSettingsSchema | undefined,
  stored: Stored,
): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const field of settingFields(schema)) {
    const value = stored?.[field.id];
    out[field.id] = isLegalSettingValue(field, value) ? value : field.default;
  }
  return out;
}

/** Stored ids that no longer parse against the schema: unknown fields and values out of range. */
export function staleSettingIds(schema: ProviderSettingsSchema | undefined, stored: Stored): string[] {
  const fields = new Map(settingFields(schema).map((f) => [f.id, f]));
  return Object.entries(stored ?? {})
    .filter(([id, value]) => {
      const field = fields.get(id);
      return !field || !isLegalSettingValue(field, value);
    })
    .map(([id]) => id);
}

const appliesTo = (field: Pick<SettingField, "models">, model: Pick<ModelManifest, "key">) =>
  !field.models || field.models.includes(model.key);

/**
 * What a run of `manifest` uses (§0.3 resolution): defaults, then stored values that still parse;
 * a field not for this model or hidden by its conditions takes its default; a choice the model
 * doesn't offer falls back (a speed to Standard, anything else to its default or first offer).
 */
export function resolveProviderSettings(
  schema: ProviderSettingsSchema | undefined,
  stored: Stored,
  manifest: Model,
  op: AdapterOp = "generate",
): ResolvedProviderSettings {
  const values: Record<string, SettingValue> = {};
  const notes: SettingNote[] = [];
  let speed: SpeedId = "standard";
  let speedRequested: SpeedId = "standard";

  for (const field of adapterFields(schema)) {
    const saved = stored?.[field.id];
    let value: SettingValue = isLegalSettingValue(field, saved) ? saved : field.default;

    if (!appliesTo(field, manifest) || !settingShown(field, values)) {
      if (value !== field.default) {
        notes.push({ field: field.id, fallback: field.default, reason: "field_not_for_model" });
      }
      value = field.default;
    } else if (field.kind === "select" && field.role === "speed") {
      speedRequested = value as SpeedId;
      if (resolveSpeed(manifest, speedRequested, op).fellBack) {
        notes.push({ field: field.id, fallback: "standard", reason: "option_not_for_model" });
        value = "standard";
      }
    } else if (field.kind === "select") {
      const offered = field.options.filter((o) => !o.models || o.models.includes(manifest.key));
      if (!offered.some((o) => o.value === value)) {
        const fallback = offered.some((o) => o.value === field.default)
          ? field.default
          : (offered[0]?.value ?? field.default);
        notes.push({ field: field.id, fallback, reason: "option_not_for_model" });
        value = fallback;
      }
    }

    values[field.id] = value;
    if (field.kind === "select" && field.role === "speed") speed = value as SpeedId;
  }
  return { values, speed, speedRequested, notes };
}

/**
 * The models (of `manifests`) that offer an option, for the modal's availability badge ("Nano
 * Banana Pro only"). Speed options read each manifest's speeds; others read the option's own list.
 */
export function modelsOffering(
  field: SettingField,
  option: SettingOption,
  manifests: readonly ModelManifest[],
): ModelManifest[] {
  return manifests.filter((m) => {
    if (!appliesTo(field, m)) return false;
    if (field.kind === "select" && field.role === "speed") {
      return !resolveSpeed(m, option.value as SpeedId).fellBack;
    }
    return !option.models || option.models.includes(m.key);
  });
}

/**
 * The models (of `manifests`) a field matters for: those it applies to and, when it only shows at
 * some speeds, that offer one of them. "When Flex is busy" only matters where Flex runs.
 */
export function modelsUsing(
  field: SettingField,
  speedFieldId: string | undefined,
  manifests: readonly ModelManifest[],
): ModelManifest[] {
  return manifests.filter(
    (m) =>
      appliesTo(field, m) &&
      (field.showWhen ?? []).every(
        (c) =>
          c.field !== speedFieldId ||
          !("in" in c) ||
          c.in.some((v) => !resolveSpeed(m, v as SpeedId).fellBack),
      ),
  );
}

export type SettingsPatchResult =
  | {
      ok: true;
      /** Values that differ from their defaults: merge into providers.settings. */
      set: Record<string, SettingValue>;
      /** Fields back at their default: remove from providers.settings. */
      unset: string[];
      /** The Limits panel's value, for providers.concurrency_cap. */
      concurrencyCap?: number;
    }
  | { ok: false; field: string; message: string };

/**
 * Checks PATCH /api/providers/:id/settings against the modal's schema (the adapter's panels plus
 * Limits): every key a declared field, every value legal for its kind, options and range.
 */
export function checkSettingsPatch(
  schema: ProviderSettingsSchema,
  patch: Readonly<Record<string, unknown>>,
): SettingsPatchResult {
  const fields = new Map(settingFields(schema).map((f) => [f.id, f]));
  const set: Record<string, SettingValue> = {};
  const unset: string[] = [];
  let concurrencyCap: number | undefined;

  for (const [id, value] of Object.entries(patch)) {
    const field = fields.get(id);
    if (!field) return { ok: false, field: id, message: `"${id}" isn't a setting here` };
    if (!isLegalSettingValue(field, value)) {
      return { ok: false, field: id, message: `That value doesn't fit "${id}"` };
    }
    if (id === CONCURRENCY_CAP_FIELD) concurrencyCap = value as number;
    else if (value === field.default) unset.push(id);
    else set[id] = value;
  }
  return { ok: true, set, unset, ...(concurrencyCap !== undefined && { concurrencyCap }) };
}
