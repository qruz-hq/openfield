import { z } from "zod";
import {
  CONCURRENCY_CAP_FIELD,
  LIMITS_PANEL_ID,
  MAX_CONCURRENCY,
  SETTING_NOTE_REASONS,
  SETTING_NUMBER_CONTROLS,
  SPEED_IDS,
  type SpeedId,
} from "../constants";
import { t } from "../i18n";
import { modelKeySchema, speedIdSchema } from "./common";

// Provider settings (§0.3): panels of fields an adapter declares for its company. Openfield renders
// them in the company's settings modal, stores what the person changed and hands the resolved values
// to the adapter on every call. Adapters never render UI and never read storage.

export const settingIdSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*$/)
  .max(64);
export const settingValueSchema = z.union([z.string().max(1000), z.number(), z.boolean()]);

/** Every condition must hold for the field to show. A hidden field resolves to its default. */
export const settingConditionSchema = z.union([
  z.strictObject({ field: settingIdSchema, in: z.array(settingValueSchema).min(1) }),
  z.strictObject({ field: settingIdSchema, notIn: z.array(settingValueSchema).min(1) }),
]);

const label = z.string().min(1).max(60);
const line = z.string().min(1).max(200);

export const settingOptionSchema = z.strictObject({
  value: z.string().min(1).max(64),
  /** The company's own name where it has one: "Flex". */
  label,
  /** One plain line. */
  description: line.optional(),
  /** Models that offer this option. Absent: every model the field applies to. */
  models: z.array(modelKeySchema).min(1).optional(),
  /** Binds the option to a speed, so availability and price come from each manifest's speeds. */
  speed: speedIdSchema.optional(),
  /**
   * The speed a run bills at under this choice, for the price on its card ("Switch to Standard").
   * Shows a price only; availability still comes from `models`.
   */
  priceAt: speedIdSchema.optional(),
});

const fieldBase = {
  /** Unique across the provider's panels. */
  id: settingIdSchema,
  label,
  description: line.optional(),
  /** May only name fields declared earlier. */
  showWhen: z.array(settingConditionSchema).min(1).optional(),
  /** Models the field applies to. Absent: every model of the provider. */
  models: z.array(modelKeySchema).min(1).optional(),
};

const selectFieldSchema = z
  .strictObject({
    ...fieldBase,
    kind: z.literal("select"),
    // As many option cards as the modal's panel shows without scrolling far.
    options: z.array(settingOptionSchema).min(1).max(8),
    default: z.string().min(1),
    /** At most one per provider: the field that picks the speed. */
    role: z.literal("speed").optional(),
  })
  .refine((f) => new Set(f.options.map((o) => o.value)).size === f.options.length, {
    message: "option values must be unique",
    path: ["options"],
  })
  .refine((f) => f.options.some((o) => o.value === f.default), {
    message: "default must be one of the options",
    path: ["default"],
  });

const toggleFieldSchema = z.strictObject({ ...fieldBase, kind: z.literal("toggle"), default: z.boolean() });

const numberFieldSchema = z
  .strictObject({
    ...fieldBase,
    kind: z.literal("number"),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    default: z.number(),
    control: z.enum(SETTING_NUMBER_CONTROLS),
  })
  .refine((f) => f.min <= f.max, { message: "min must not be above max", path: ["max"] })
  .refine((f) => onStep(f.default, f.min, f.max, f.step), {
    message: "default must be in range and on a step",
    path: ["default"],
  });

const textFieldSchema = z
  .strictObject({
    ...fieldBase,
    kind: z.literal("text"),
    default: z.string(),
    maxLength: z.int().positive().max(1000),
    placeholder: z.string().max(80).optional(),
  })
  .refine((f) => f.default.length <= f.maxLength, {
    message: "default is longer than maxLength",
    path: ["default"],
  });

export const settingFieldSchema = z.discriminatedUnion("kind", [
  selectFieldSchema,
  toggleFieldSchema,
  numberFieldSchema,
  textFieldSchema,
]);

export const settingsPanelSchema = z.strictObject({
  /** Unique within the provider. "limits" is Openfield's. */
  id: settingIdSchema,
  /** Panel list entry and heading: "Speed". */
  label,
  description: line.optional(),
  fields: z.array(settingFieldSchema).min(1),
});

/** What the modal's panel list holds without scrolling far, Openfield's Limits panel included. */
const MAX_PANELS = 12;

const schemaShape = z.strictObject({
  /** Bump when a field's meaning changes. */
  version: z.int().positive(),
  panels: z.array(settingsPanelSchema).max(MAX_PANELS),
});

type ShapeOutput = z.output<typeof schemaShape>;
type FieldOutput = z.output<typeof settingFieldSchema>;

// Only text can hold a key, and a key is a credential field, never a setting (§0.3 rule 1).
const SECRET_ID = /key|secret|token|password/i;

/** §0.3's five rules. `adapter` also forbids Openfield's reserved ids. */
function checkRules(schema: ShapeOutput, ctx: z.RefinementCtx, adapter: boolean): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const panelIds = new Set<string>();
  const earlier = new Map<string, FieldOutput>();
  let speedFields = 0;
  if (adapter && schema.panels.length > MAX_PANELS - 1) {
    issue(["panels"], `At most ${MAX_PANELS - 1} panels: Openfield adds its Limits panel after them`);
  }

  schema.panels.forEach((panel, p) => {
    if (panelIds.has(panel.id)) issue(["panels", p, "id"], `Panel "${panel.id}" is declared twice`);
    panelIds.add(panel.id);
    if (adapter && panel.id === LIMITS_PANEL_ID) {
      issue(["panels", p, "id"], `"${LIMITS_PANEL_ID}" is Openfield's own panel`);
    }

    panel.fields.forEach((field, f) => {
      const path = ["panels", p, "fields", f];
      if (earlier.has(field.id)) issue([...path, "id"], `Field "${field.id}" is declared twice`);
      if (adapter && field.id === CONCURRENCY_CAP_FIELD) {
        issue([...path, "id"], `"${CONCURRENCY_CAP_FIELD}" is Openfield's own field`);
      }
      if (field.kind === "text" && SECRET_ID.test(field.id)) {
        issue([...path, "id"], "Keys are credentials, never settings");
      }

      for (const [c, condition] of (field.showWhen ?? []).entries()) {
        const target = earlier.get(condition.field);
        if (!target) {
          issue([...path, "showWhen", c], "showWhen may only name a field declared earlier");
          continue;
        }
        const values = "in" in condition ? condition.in : condition.notIn;
        if (!values.every((v) => isLegalSettingValue(target, v))) {
          issue([...path, "showWhen", c], `"${condition.field}" can't hold one of these values`);
        }
      }

      if (field.kind === "select") {
        if (field.role === "speed") speedFields++;
        checkSelect(field, path, issue);
      }
      earlier.set(field.id, field);
    });
  });

  if (speedFields > 1) issue(["panels"], "At most one field may pick the speed");
}

function checkSelect(
  field: Extract<FieldOutput, { kind: "select" }>,
  path: (string | number)[],
  issue: (path: (string | number)[], message: string) => void,
): void {
  const byValue = new Map(field.options.map((o) => [o.value, o]));
  if (field.role === "speed") {
    if (!byValue.has("standard")) issue([...path, "options"], "A speed field offers standard");
    if (field.default !== "standard") issue([...path, "default"], "A speed field defaults to standard");
    field.options.forEach((o, i) => {
      const at = [...path, "options", i];
      if (!(SPEED_IDS as readonly string[]).includes(o.value)) issue(at, `"${o.value}" isn't a speed`);
      if (o.value !== "standard" && o.speed !== o.value)
        issue(at, "Each speed option sets speed to its value");
      if (o.value === "standard" && o.speed !== undefined && o.speed !== "standard") {
        issue(at, "The standard option can only bind to standard");
      }
      // Availability and prices come from each manifest's speeds, so they live in one place.
      if (o.models) issue(at, "Speed options never list models");
      if (o.priceAt !== undefined) issue(at, "Speed options take their price from their speed");
    });
    return;
  }

  field.options.forEach((o, i) => {
    if (o.speed !== undefined) issue([...path, "options", i], "Only the speed field binds options to speeds");
  });
  // Rule 3: the default must be offered by every model the field applies to.
  const fallback = byValue.get(field.default);
  if (fallback?.models && !field.models?.every((m) => fallback.models?.includes(m))) {
    issue([...path, "default"], "The default must be offered by every model the field applies to");
  }
}

function onStep(value: number, min: number, max: number, step: number): boolean {
  if (!Number.isFinite(value) || value < min || value > max) return false;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** What an adapter declares on Provider.settings. Every §0.3 rule applies, reserved ids included. */
export const providerSettingsSchemaSchema = schemaShape.superRefine((s, ctx) => checkRules(s, ctx, true));

/** The modal's view: the adapter's panels, then Openfield's Limits panel. */
export const providerSettingsWithLimitsSchema = schemaShape.superRefine((s, ctx) =>
  checkRules(s, ctx, false),
);

/** Stored per provider in providers.settings: only the values the person changed. */
export const providerSettingValuesSchema = z.record(settingIdSchema, settingValueSchema);

export const settingNoteSchema = z.object({
  field: settingIdSchema,
  /** What the field resolved to instead of the stored value. */
  fallback: settingValueSchema,
  reason: z.enum(SETTING_NOTE_REASONS),
});

/** resolveProviderSettings() for one model: what a run of that model uses. */
export const resolvedProviderSettingsSchema = z.object({
  /** Every field of the provider, defaults filled. Openfield's Limits panel is never in here. */
  values: providerSettingValuesSchema,
  /** What this model runs at. */
  speed: speedIdSchema,
  /** What the settings ask for. Differs when the model doesn't offer it. */
  speedRequested: speedIdSchema,
  notes: z.array(settingNoteSchema),
});

/** GET and PATCH /api/providers/:id/settings (§8.3). Works with or without a key. */
export const providerSettingsResponseSchema = z.object({
  schema: providerSettingsWithLimitsSchema,
  /** Every field, stored values over defaults, concurrencyCap from providers.concurrency_cap. */
  values: providerSettingValuesSchema,
});

/** PATCH /api/providers/:id/settings: any subset of field ids. The server checks each against its field. */
export const providerSettingsPatchBodySchema = z.strictObject({ values: providerSettingValuesSchema });

export type SettingValue = z.infer<typeof settingValueSchema>;
export type SettingCondition = z.infer<typeof settingConditionSchema>;
export type SettingOption = z.infer<typeof settingOptionSchema>;
export type SettingField = z.infer<typeof settingFieldSchema>;
export type SelectSettingField = Extract<SettingField, { kind: "select" }>;
export type NumberSettingField = Extract<SettingField, { kind: "number" }>;
export type SettingsPanel = z.infer<typeof settingsPanelSchema>;
export type ProviderSettingsSchema = z.infer<typeof providerSettingsSchemaSchema>;
export type ProviderSettingValues = z.infer<typeof providerSettingValuesSchema>;
export type SettingNote = z.infer<typeof settingNoteSchema>;
export type ResolvedProviderSettings = z.infer<typeof resolvedProviderSettingsSchema>;
export type ProviderSettingsResponse = z.infer<typeof providerSettingsResponseSchema>;
export type ProviderSettingsPatchBody = z.infer<typeof providerSettingsPatchBodySchema>;

/** Whether `value` fits the field's kind, options and range. Model availability is checked elsewhere. */
export function isLegalSettingValue(field: SettingField, value: unknown): value is SettingValue {
  switch (field.kind) {
    case "select":
      return typeof value === "string" && field.options.some((o) => o.value === value);
    case "toggle":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && onStep(value, field.min, field.max, field.step);
    case "text":
      return typeof value === "string" && value.length <= field.maxLength;
  }
}

/** Every field in declared order, panel by panel. */
export function settingFields(schema: { panels: readonly SettingsPanel[] } | undefined): SettingField[] {
  return schema?.panels.flatMap((p) => p.fields) ?? [];
}

/** The field that picks the speed, if the provider declares one. */
export function speedSettingField(
  schema: { panels: readonly SettingsPanel[] } | undefined,
): SelectSettingField | undefined {
  return settingFields(schema).find(
    (f): f is SelectSettingField => f.kind === "select" && f.role === "speed",
  );
}

/** A speed's name as people see it: the company's own label on its Speed field, else Openfield's. */
export function speedName(schema: { panels: readonly SettingsPanel[] } | undefined, speed: SpeedId): string {
  const option = speedSettingField(schema)?.options.find((o) => o.value === speed);
  return option?.label ?? t(`speed.names.${speed}`);
}

/**
 * Openfield's own panel, the last one in every company's modal. Its value lives in
 * providers.concurrency_cap and never reaches an adapter: the scheduler reads the cap itself (§0.12).
 */
export function limitsPanel(opts: { company: string; defaultCap: number }): SettingsPanel {
  const cap = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(opts.defaultCap)));
  return {
    id: LIMITS_PANEL_ID,
    label: t("providerSettings.limits.label"),
    fields: [
      {
        id: CONCURRENCY_CAP_FIELD,
        kind: "number",
        control: "stepper",
        label: t("providerSettings.limits.runsAtOnce"),
        description: t("providerSettings.limits.runsAtOnceHint", { company: opts.company }),
        min: 1,
        max: MAX_CONCURRENCY,
        step: 1,
        default: cap,
      },
    ],
  };
}

/** The adapter's panels (if any) with Openfield's Limits panel appended, as GET /settings serves it. */
export function withLimitsPanel(
  schema: ProviderSettingsSchema | undefined,
  opts: { company: string; defaultCap: number },
): ProviderSettingsSchema {
  return { version: schema?.version ?? 1, panels: [...(schema?.panels ?? []), limitsPanel(opts)] };
}
