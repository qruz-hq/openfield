import { z } from "zod";
import { assetSchema } from "./asset";
import { jobSourceSchema, modelKeySchema, ulidSchema } from "./common";

// Layer separation: a model splits one image into a base and separate transparent layers, each
// cropped to its own box. Every one of them is a library image whose opParams.layer says where it
// sits; a stack is the images one run made, so the run's id names it.

/** The size a separation comes out at: "auto" keeps the image's own, within the model's range. */
export const LAYER_SIZES = ["auto", "1K", "1.5K", "2K"] as const;
export type LayerSize = (typeof LAYER_SIZES)[number];
export const layerSizeSchema = z.enum(LAYER_SIZES);

/** The most layers one separation makes, besides its base (Seedream: 16). */
export const LAYERS_MAX = 16;

/** The most a separation's words (which parts to separate) can say. */
export const LAYERS_PROMPT_MAX = 4000;

/** request.layers, on a decompose run. */
export const layerRequestSchema = z.object({ size: layerSizeSchema.optional() });

const edge = z.int().min(0).max(65_536);
/** [left, top, right, bottom], in pixels of the stack's canvas (its base image). */
export const layerBoxSchema = z.tuple([edge, edge, edge, edge]);
/** The same box on a 0 to 1000 grid, as the company sent it. */
const grid = z.int().min(0).max(1000);
export const layerGridBoxSchema = z.tuple([grid, grid, grid, grid]);

/** What a separated image records in opParams.layer. */
export const layerOpParamsSchema = z.object({
  /** The base covers the whole canvas; a layer covers its box. */
  role: z.enum(["base", "layer"]),
  /** 0 for the base, then 1 upwards: a higher layer sits on top. */
  zIndex: z.int().min(0),
  /** The canvas every box is measured on: the base's own size. */
  canvas: z.object({ width: z.int().positive(), height: z.int().positive() }),
  /**
   * Where a layer sits. Its own image can differ from the box by a pixel or so, and is scaled to
   * the box when the stack is put together. Absent on the base.
   */
  box: layerBoxSchema.optional(),
  boxGrid: layerGridBoxSchema.optional(),
  /** The model's short name for a layer, and its longer description. */
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

/**
 * A separation's layer, as opposed to its base. Layers are filed under the base's job, so wherever
 * a job's own image is looked up, a layer is passed over.
 */
export const isStackLayer = (opParams: unknown): boolean =>
  (opParams as { layer?: { role?: unknown } } | null | undefined)?.layer?.role === "layer";

/**
 * POST /api/layers: separates one library image into layers. The run lands like any other, as a
 * base and its layers in the library, linked to the image they came from.
 */
export const layersBodySchema = z.object({
  idempotencyKey: ulidSchema,
  model: modelKeySchema,
  /** The image to separate. */
  image: ulidSchema,
  size: layerSizeSchema.optional(),
  /** Optional: which parts to separate, in words. Without one the model picks the main elements. */
  prompt: z.string().max(LAYERS_PROMPT_MAX).optional(),
  source: jobSourceSchema.default("detail_editor"),
  canvas: z.object({ canvasId: ulidSchema, nodeId: z.string().min(1).max(64) }).optional(),
});

/** One image in a stack, bottom first. */
export const stackLayerSchema = z.object({
  asset: assetSchema,
  role: z.enum(["base", "layer"]),
  zIndex: z.int().min(0),
  box: layerBoxSchema,
  name: z.string().nullable(),
  description: z.string().nullable(),
});

/** GET /api/layers/:runId */
export const layerStackResponseSchema = z.object({
  runId: ulidSchema,
  /** The image that was separated. Null once it's deleted for good. */
  source: assetSchema.nullable(),
  canvas: z.object({ width: z.int().positive(), height: z.int().positive() }),
  /** The base first, then each layer from the bottom up. */
  layers: z.array(stackLayerSchema),
});

/**
 * One entry of a stack to put together, bottom first. An image edited from a layer may stand in
 * for it: its box is then the box of the layer it came from, unless one is given.
 */
export const stackEntrySchema = z.object({
  assetId: ulidSchema,
  /** Where to draw it, in canvas pixels. Absent: where the separation put it. */
  box: layerBoxSchema.optional(),
  /** Hidden entries are left out. Default true. */
  visible: z.boolean().optional(),
});

/** POST /api/layers/:runId/flatten and /export. Without `layers`, the stack as it was made. */
export const stackBodySchema = z.object({
  layers: z
    .array(stackEntrySchema)
    .min(1)
    .max(LAYERS_MAX + 16)
    .optional(),
});

export const layerExportBodySchema = stackBodySchema.extend({ format: z.enum(["zip", "psd"]) });

/** POST /api/layers/:runId/flatten answers the new image. */
export const flattenResponseSchema = z.object({ asset: assetSchema });

export type LayerRequest = z.infer<typeof layerRequestSchema>;
export type LayerBox = z.infer<typeof layerBoxSchema>;
export type LayerOpParams = z.infer<typeof layerOpParamsSchema>;
export type LayersBody = z.input<typeof layersBodySchema>;
export type StackLayer = z.infer<typeof stackLayerSchema>;
export type LayerStackResponse = z.infer<typeof layerStackResponseSchema>;
export type StackEntry = z.infer<typeof stackEntrySchema>;
export type StackBody = z.infer<typeof stackBodySchema>;
export type LayerExportBody = z.infer<typeof layerExportBodySchema>;
export type FlattenResponse = z.infer<typeof flattenResponseSchema>;
