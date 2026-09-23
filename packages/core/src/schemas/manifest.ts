import { z } from "zod";
import {
  BACKGROUND_VALUES,
  BATCH_MAX,
  CONTROL_IDS,
  CONTROL_STATES,
  MODEL_BADGES,
  MODEL_SOURCES,
  PROMPT_ENHANCE_MODES,
  REFERENCE_STRENGTH_MODES,
  UNSUPPORTED_PARAM_POLICIES,
} from "../constants";
import {
  aspectRatioSchema,
  dateOrTimestampSchema,
  modelIdSchema,
  modelKeySchema,
  outputFormatSchema,
  pixelSizeSchema,
  providerIdSchema,
  referenceRoleSchema,
  resolutionTierSchema,
} from "./common";
import { priceModelSchema } from "./cost";

// The capability manifest (§0.3, §6.3). Objects are strict: conformance test 1 parses every
// static catalog with no unknown fields, so a typo fails loudly instead of hiding a control.

export const controlIdSchema = z.enum(CONTROL_IDS);
export const controlStateSchema = z.enum(CONTROL_STATES);
export const backgroundSchema = z.enum(BACKGROUND_VALUES);

export const qualityLevelSchema = z.strictObject({
  /** Provider-native value sent on the wire. */
  id: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
});

// Restricted JSON Schema for the Advanced chip (§3.4.7).
const extraFieldBase = { title: z.string().min(1), description: z.string().optional() };
const numberBounds = {
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
};

export const extraFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    ...extraFieldBase,
    enum: z.array(z.string()).min(1).optional(),
    maxLength: z.int().positive().optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("number"),
    ...extraFieldBase,
    ...numberBounds,
    default: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal("integer"),
    ...extraFieldBase,
    ...numberBounds,
    default: z.int().optional(),
  }),
  z.strictObject({ type: z.literal("boolean"), ...extraFieldBase, default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal("array"),
    ...extraFieldBase,
    items: z.strictObject({ type: z.literal("string"), enum: z.array(z.string()).min(1).optional() }),
    default: z.array(z.string()).optional(),
  }),
]);

export const extraSchemaSchema = z.strictObject({
  type: z.literal("object"),
  properties: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), extraFieldSchema),
  required: z.array(z.string()).optional(),
});

const sizeCapabilitySchema = z.discriminatedUnion("mode", [
  z
    .strictObject({
      mode: z.literal("aspect"),
      ratios: z.array(aspectRatioSchema).min(1),
      default: aspectRatioSchema,
    })
    .refine((s) => s.ratios.includes(s.default), {
      message: "default must be one of ratios",
      path: ["default"],
    }),
  z.strictObject({
    mode: z.literal("enum"),
    sizes: z.array(pixelSizeSchema).min(1),
    default: pixelSizeSchema,
    allowAuto: z.boolean(),
  }),
  z.strictObject({
    mode: z.literal("free"),
    minEdge: z.int().positive(),
    maxEdge: z.int().positive(),
    multipleOf: z.int().positive(),
    default: pixelSizeSchema,
  }),
]);

const pair = z.tuple([z.number(), z.number()]);

export const capabilitiesSchema = z.strictObject({
  ops: z.strictObject({
    textToImage: z.boolean(),
    imageEdit: z.boolean(),
    inpaint: z.boolean(),
    outpaint: z.boolean(),
    upscale: z.boolean(),
    removeBackground: z.boolean(),
    detectText: z.boolean(),
    decomposeLayers: z.boolean(),
  }),

  references: z
    .strictObject({
      supported: z.boolean(),
      max: z.int().nonnegative(),
      roles: z.array(referenceRoleSchema),
      mimeTypes: z.array(z.string().min(1)),
      maxBytes: z.int().nonnegative(),
      maxPixels: z.int().positive().optional(),
      weights: z.boolean(),
      strengthMode: z.enum(REFERENCE_STRENGTH_MODES),
    })
    .refine((r) => r.supported || r.max === 0, { message: "max is 0 when references are unsupported" }),

  size: sizeCapabilitySchema,

  resolution: z
    .strictObject({ tiers: z.array(resolutionTierSchema).min(1), default: resolutionTierSchema })
    .refine((r) => r.tiers.includes(r.default), {
      message: "default must be one of tiers",
      path: ["default"],
    })
    .optional(),
  quality: z
    .strictObject({ levels: z.array(qualityLevelSchema).min(1), default: z.string().min(1) })
    .refine((q) => q.levels.some((l) => l.id === q.default), {
      message: "default must be one of the level ids",
      path: ["default"],
    })
    .optional(),

  batch: z.strictObject({ max: z.int().min(1).max(BATCH_MAX), native: z.boolean() }),
  seed: z.strictObject({ supported: z.boolean(), range: pair.optional(), echoed: z.boolean() }),

  negativePrompt: z.boolean(),
  promptEnhance: z.enum(PROMPT_ENHANCE_MODES),
  styleStrength: z.boolean(),

  background: z
    .strictObject({ values: z.array(backgroundSchema).min(1), default: z.literal("auto") })
    .refine((b) => b.values.includes(b.default), {
      message: "default must be one of values",
      path: ["default"],
    })
    .optional(),
  transparency: z.boolean(),

  streaming: z.strictObject({
    partialImages: z.boolean(),
    maxPartials: z.int().positive().optional(),
    progressPercent: z.boolean(),
  }),

  output: z
    .strictObject({
      formats: z.array(outputFormatSchema).min(1),
      default: outputFormatSchema,
      compression: z
        .strictObject({ min: z.int().min(0), max: z.int().max(100), default: z.int().min(0).max(100) })
        .optional(),
    })
    .refine((o) => o.formats.includes(o.default), {
      message: "default must be one of formats",
      path: ["default"],
    }),

  safety: z
    .strictObject({
      moderation: z
        .strictObject({ values: z.array(z.string().min(1)).min(1), default: z.string(), label: z.string() })
        .optional(),
      /** Irreversible provider behaviour the person must be told about, in our words. */
      notices: z.array(z.string()).optional(),
    })
    .optional(),

  identity: z.strictObject({ nativeCharacterRefs: z.boolean(), nativeStylePresets: z.boolean() }),

  limits: z.strictObject({
    maxPromptChars: z.int().positive().optional(),
    requestTimeoutMs: z.int().positive(),
    /** p50, p95. Drives placeholder copy, not correctness. */
    typicalLatencyMs: pair,
    maxConcurrent: z.int().positive(),
  }),

  /** Chip order in the composer and the canvas node footer. */
  controlOrder: z
    .array(controlIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, { message: "controlOrder has duplicates" }),
  extraSchema: extraSchemaSchema.optional(),

  /** Control exists but some options are unavailable. */
  partial: z
    .partialRecord(
      controlIdSchema,
      z.strictObject({ unavailable: z.array(z.string()).min(1), reason: z.string() }),
    )
    .optional(),
  /** Control is faked by the adapter (batch fan-out, appended Avoid text). */
  emulated: z.array(controlIdSchema).optional(),
  /** Control is absent on purpose, with copy for the disabled tooltip. */
  unsupported: z.partialRecord(controlIdSchema, z.strictObject({ reason: z.string().min(1) })).optional(),

  unsupportedParamPolicy: z.enum(UNSUPPORTED_PARAM_POLICIES),
});

export const modelManifestSchema = z
  .strictObject({
    key: modelKeySchema,
    providerId: providerIdSchema,
    /** Provider-native id sent on the wire. */
    modelId: modelIdSchema,
    displayName: z.string().min(1),
    /** Model picker subtitle. */
    description: z.string().max(90).optional(),
    family: z.string().optional(),
    badges: z.array(z.enum(MODEL_BADGES)).optional(),
    capabilities: capabilitiesSchema,
    price: priceModelSchema,
    source: z.enum(MODEL_SOURCES),
    /** Bumped on any capability change; frozen onto the job set. */
    manifestVersion: z.string().min(1),
    fetchedAt: dateOrTimestampSchema,
  })
  .refine((m) => m.key === `${m.providerId}:${m.modelId}`, {
    message: "key must be <providerId>:<modelId>",
    path: ["key"],
  });

/** What resolveControl() returns for one control on one model (§0.3). */
export const resolvedControlSchema = z.object({
  state: controlStateSchema,
  options: z.array(z.unknown()).optional(),
  default: z.unknown().optional(),
  /** Tooltip copy when the control is disabled or partly available. */
  reason: z.string().optional(),
});

export type ResolvedControl = z.infer<typeof resolvedControlSchema>;
export type QualityLevel = z.infer<typeof qualityLevelSchema>;
export type ExtraField = z.infer<typeof extraFieldSchema>;
export type ExtraSchema = z.infer<typeof extraSchemaSchema>;
export type SizeCapability = z.infer<typeof sizeCapabilitySchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type ModelManifest = z.infer<typeof modelManifestSchema>;
