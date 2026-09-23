import { z } from "zod";
import { ADAPTER_OPS, type AdapterOp, DIAGNOSTIC_LEVELS, EDIT_OPS, type Op } from "../constants";
import { HASH_RE } from "../hash";
import {
  aspectRatioSchema,
  batchSchema,
  entityIdSchema,
  jobSourceSchema,
  modelKeySchema,
  opSchema,
  outputFormatSchema,
  pixelSizeSchema,
  referenceRoleSchema,
  resolutionTierSchema,
  ulidSchema,
} from "./common";
import { backgroundSchema } from "./manifest";

// One body for POST /api/generate and POST /api/edit (§0.6, §6.5).

export const sizeSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  z.object({ kind: z.literal("aspect"), ratio: aspectRatioSchema }),
  z.object({
    kind: z.literal("pixels"),
    width: z.int().min(64).max(16384),
    height: z.int().min(64).max(16384),
  }),
]);

export const referenceInputSchema = z.object({
  assetId: ulidSchema,
  role: referenceRoleSchema,
  /** 0 to 1, only honoured when the model takes weights. */
  weight: z.number().min(0).max(1).optional(),
});

export const maskInputSchema = z.object({
  /** An RGBA PNG asset at the base image's exact size. Alpha 0 is the area to regenerate (§0.9). */
  assetId: ulidSchema,
  /** Applied by core before upload; never reaches the adapter. */
  invert: z.boolean().optional(),
  featherPx: z.int().min(0).max(32).optional(),
});

const edgePx = z.int().min(0).max(8192);

// Kept free of object-level refinements so other packages can pick, omit and extend it.
export const generateRequestSchema = z.object({
  /** Client ULID, one per job set. A repeat returns the existing job set. */
  idempotencyKey: ulidSchema,
  model: modelKeySchema,
  op: opSchema,

  prompt: z.string().max(32_000),
  negativePrompt: z.string().max(4_000).optional(),
  enhancePrompt: z.boolean().optional(),

  size: sizeSpecSchema,
  resolution: resolutionTierSchema.optional(),
  /** A QualityLevel id. */
  quality: z.string().min(1).max(64).optional(),
  background: backgroundSchema.optional(),
  output: z
    .object({ format: outputFormatSchema, compression: z.int().min(0).max(100).optional() })
    .optional(),

  batch: batchSchema,
  /** Null or absent: the server picks one per image when the model supports seeds (§0.11). */
  seed: z.int().min(0).max(2_147_483_647).nullish(),

  references: z.array(referenceInputSchema).max(64).optional(),
  /** Source image for edit, inpaint, outpaint and upscale. */
  base: referenceInputSchema.optional(),
  mask: maskInputSchema.optional(),
  expand: z.object({ top: edgePx, right: edgePx, bottom: edgePx, left: edgePx }).optional(),

  presetId: entityIdSchema.optional(),
  presetStrength: z.number().min(0).max(1).optional(),
  characterId: entityIdSchema.optional(),
  referenceSetId: entityIdSchema.optional(),
  paletteId: entityIdSchema.optional(),
  moderation: z.string().min(1).max(64).optional(),

  source: jobSourceSchema,
  canvas: z.object({ canvasId: ulidSchema, nodeId: z.string().min(1).max(64) }).optional(),
  /** Advanced fields, passed to the adapter under the model's own names. */
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/generate */
export const generateBodySchema = generateRequestSchema.extend({ op: z.literal("generate") });
/** POST /api/edit */
export const editBodySchema = generateRequestSchema.extend({ op: z.enum(EDIT_OPS) });

/** What every adapter method receives, after presets, characters and palettes are resolved. */
export const normalizedRequestSchema = generateRequestSchema
  .omit({
    presetId: true,
    presetStrength: true,
    characterId: true,
    referenceSetId: true,
    paletteId: true,
    size: true,
    seed: true,
  })
  .extend({
    jobId: ulidSchema,
    jobSetId: ulidSchema,
    batchIndex: z.int().min(0),
    /** 1 when the runner fans out. */
    batch: batchSchema,
    size: z.union([pixelSizeSchema, z.strictObject({ aspect: aspectRatioSchema })]),
    /** Only filled when the model supports seeds. */
    seed: z.int().min(0).max(4_294_967_295).optional(),
    promptAfterPreset: z.string(),
    manifestVersion: z.string().min(1),
    paramsHash: z.string().regex(HASH_RE),
  });

/** POST /api/models/:providerId/:modelId/estimate, for server-side callers and the canvas preview. */
export const estimateBodySchema = generateRequestSchema
  .omit({ idempotencyKey: true, model: true, source: true, canvas: true })
  .partial({ prompt: true, size: true });

export const diagnosticSchema = z.object({
  level: z.enum(DIAGNOSTIC_LEVELS),
  field: z.string().optional(),
  code: z.string().min(1),
  message: z.string(),
});

export const adapterOpSchema = z.enum(ADAPTER_OPS);

/**
 * The adapter op a recorded op compiles to (§0.4), or null for local and plugin-only ops.
 * Widget edits become an inpaint only when there's a mask and the model can inpaint.
 */
export function adapterOpFor(op: Op, opts: { hasMask: boolean; canInpaint: boolean }): AdapterOp | null {
  switch (op) {
    case "generate":
    case "edit":
    case "inpaint":
    case "outpaint":
    case "upscale":
    case "remove_bg":
      return op;
    case "variation":
      return "generate";
    case "relight":
    case "angles":
    case "enhance":
    case "text_edit":
      return opts.hasMask && opts.canInpaint ? "inpaint" : "edit";
    case "decompose":
    case "crop":
    case "grade":
    case "overlay":
      return null;
  }
}

export type SizeSpec = z.infer<typeof sizeSpecSchema>;
export type ReferenceInput = z.infer<typeof referenceInputSchema>;
export type MaskInput = z.infer<typeof maskInputSchema>;
export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type GenerateBody = z.infer<typeof generateBodySchema>;
export type EditBody = z.infer<typeof editBodySchema>;
export type NormalizedRequest = z.infer<typeof normalizedRequestSchema>;
export type EstimateBody = z.infer<typeof estimateBodySchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
