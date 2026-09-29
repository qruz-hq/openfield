import { z } from "zod";
import {
  BACKGROUND_VALUES,
  BATCH_MAX,
  CONTROL_IDS,
  CONTROL_STATES,
  DEFAULT_MODALITY,
  MODEL_BADGES,
  MODEL_SOURCES,
  type Modality,
  PROMPT_ENHANCE_MODES,
  REFERENCE_STRENGTH_MODES,
  SPEED_DELIVERIES,
  UNSUPPORTED_PARAM_POLICIES,
} from "../constants";
import {
  adapterOpSchema,
  aspectRatioSchema,
  dateOrTimestampSchema,
  modalitySchema,
  modelIdSchema,
  modelKeySchema,
  outputFormatSchema,
  pixelSizeSchema,
  providerIdSchema,
  referenceRoleSchema,
  resolutionTierSchema,
  speedIdSchema,
  videoResolutionSchema,
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

/**
 * What a video model makes (§0.3). Only on manifests with modality "video"; the image controls
 * (size, seed, batch) still describe it, and this adds what only video has. Ratios come from
 * `size`, where "auto" is the company's own choice of shape.
 */
export const videoCapabilitySchema = z
  .strictObject({
    resolutions: z.array(videoResolutionSchema).min(1),
    defaultResolution: videoResolutionSchema,
    /** Whole seconds the model can make, shortest first. */
    durations: z.array(z.int().positive()).min(1),
    defaultDuration: z.int().positive(),
    fps: z.int().positive(),
    /** The exact pixels each resolution and ratio comes out at, from the company's table. */
    sizes: z
      .array(
        z.strictObject({
          resolution: videoResolutionSchema,
          aspect: aspectRatioSchema,
          width: z.int().positive(),
          height: z.int().positive(),
        }),
      )
      .min(1),
    /** Images the video starts or ends on. */
    frames: z.strictObject({
      start: z.boolean(),
      end: z.boolean(),
      mimeTypes: z.array(z.string().min(1)),
      maxBytes: z.int().nonnegative(),
    }),
    /**
     * When "auto" may be picked: always, or only with a start frame, whose shape it then takes.
     * `startFrameForcesAuto`: with a start frame the video always takes the frame's shape.
     */
    autoAspect: z.enum(["always", "with_start_frame"]),
    startFrameForcesAuto: z.boolean(),
    /** Sound made with the picture. */
    audio: z.strictObject({ supported: z.boolean(), default: z.boolean() }),
    /** A switch that keeps the camera still. */
    cameraFixed: z.boolean(),
  })
  .refine((v) => v.resolutions.includes(v.defaultResolution), {
    message: "defaultResolution must be one of resolutions",
    path: ["defaultResolution"],
  })
  .refine((v) => v.durations.includes(v.defaultDuration), {
    message: "defaultDuration must be one of durations",
    path: ["defaultDuration"],
  })
  .refine((v) => v.frames.start || !v.frames.end, {
    message: "an end frame needs a start frame",
    path: ["frames", "end"],
  })
  .refine((v) => v.audio.supported || !v.audio.default, {
    message: "sound can't default on when it isn't supported",
    path: ["audio", "default"],
  });

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

  /** Video models only. */
  video: videoCapabilitySchema.optional(),
});

/**
 * A speed a model offers besides Standard (§0.3), priced in the same union as the manifest's
 * Standard price so the estimate has one code path. Declared only when the company's own pricing
 * page lists it for that model.
 */
export const speedOfferSchema = z
  .strictObject({
    id: speedIdSchema.exclude(["standard"]),
    price: priceModelSchema,
    /** async: results arrive later from a provider batch. */
    delivery: z.enum(SPEED_DELIVERIES),
    /** From the company's docs. Drives copy and timers, never correctness. */
    waitMs: z
      .strictObject({ target: z.int().positive(), max: z.int().positive() })
      .refine((w) => w.target <= w.max, { message: "target must not be above max", path: ["target"] }),
    /** Per-attempt timeout at this speed, for sync speeds. Overrides limits.requestTimeoutMs. */
    requestTimeoutMs: z.int().positive().optional(),
    /** Operations this speed covers. Absent: every op the model has. */
    ops: z.array(adapterOpSchema).min(1).optional(),
  })
  .refine((o) => (o.delivery === "async") === (o.id === "batch"), {
    message: "delivery is async exactly when the speed is batch",
    path: ["delivery"],
  })
  .refine((o) => o.delivery === "sync" || o.requestTimeoutMs === undefined, {
    message: "requestTimeoutMs is for sync speeds",
    path: ["requestTimeoutMs"],
  })
  .refine((o) => o.price.kind !== "unknown", {
    message: "a speed needs the company's own price",
    path: ["price"],
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
    /** What the model makes. Absent: images, as every model did before video. */
    modality: modalitySchema.optional(),
    badges: z.array(z.enum(MODEL_BADGES)).optional(),
    capabilities: capabilitiesSchema,
    /** The Standard price. */
    price: priceModelSchema,
    /** Other speeds this model offers, each with its own price. Absent: Standard only. */
    speeds: z
      .array(speedOfferSchema)
      .refine((offers) => new Set(offers.map((o) => o.id)).size === offers.length, {
        message: "each speed is offered once",
      })
      .optional(),
    /**
     * Sync speeds whose sent calls survive a restart: the company keeps working with no open
     * connection and answers a status read by id later (§0.4, §6.3). Absent: none. Batch is never
     * listed, because the batch path always resumes. A change here bumps manifestVersion.
     */
    resumableSpeeds: z
      .array(speedIdSchema.exclude(["batch"]))
      .refine((ids) => new Set(ids).size === ids.length, { message: "each speed is listed once" })
      .optional(),
    /**
     * submit() sends the idempotency key and the company honours it: a create sent again with the
     * same key returns the first call instead of starting a second one (§0.4, §6.3). A resumable
     * create whose answer was lost, on the network or to a restart, is then sent again to get its id
     * back. Absent: such a create ends the image, since sending it again could bill twice. A change
     * here bumps manifestVersion.
     */
    idempotentSubmit: z.literal(true).optional(),
    source: z.enum(MODEL_SOURCES),
    /** Bumped on any capability or speed change; frozen onto the job set. */
    manifestVersion: z.string().min(1),
    fetchedAt: dateOrTimestampSchema,
  })
  .refine((m) => m.key === `${m.providerId}:${m.modelId}`, {
    message: "key must be <providerId>:<modelId>",
    path: ["key"],
  })
  .refine((m) => (m.modality === "video") === (m.capabilities.video !== undefined), {
    message: "a video model declares capabilities.video, and only a video model does",
    path: ["capabilities", "video"],
  })
  .refine((m) => m.price.kind !== "video_tokens" || m.capabilities.video !== undefined, {
    message: "a video price needs capabilities.video for its sizes",
    path: ["price"],
  })
  .refine(
    (m) =>
      (m.resumableSpeeds ?? []).every(
        (id) => id === "standard" || m.speeds?.some((o) => o.id === id && o.delivery === "sync"),
      ),
    { message: "a resumable speed must be one the model offers", path: ["resumableSpeeds"] },
  );

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
export type VideoCapability = z.infer<typeof videoCapabilitySchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type ModelManifest = z.infer<typeof modelManifestSchema>;
export type SpeedOffer = z.infer<typeof speedOfferSchema>;

/** What a model makes: its own modality, or images when it names none. */
export const modalityOf = (manifest: Pick<ModelManifest, "modality">): Modality =>
  manifest.modality ?? DEFAULT_MODALITY;
