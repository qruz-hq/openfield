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

/** The most layers one separation can make, besides its base (Seedream 5.5: 99; 5.0 Pro: 16). */
export const LAYERS_MAX = 99;

/** The most a separation's words (which parts to separate) can say. */
export const LAYERS_PROMPT_MAX = 4000;

/** How many layers a person may ask for at most, on models that let them choose. */
export const layerCountSchema = z.int().min(1).max(LAYERS_MAX);

/** request.layers, on a decompose run. */
export const layerRequestSchema = z.object({
  size: layerSizeSchema.optional(),
  /** The most layers to make, besides the base, on models that take it. Unset: the model's default. */
  maxLayers: layerCountSchema.optional(),
});

const edge = z.int().min(0).max(65_536);
/** [left, top, right, bottom], in pixels of the stack's canvas (its base image). */
export const layerBoxSchema = z.tuple([edge, edge, edge, edge]);
/** The same box on a 0 to 1000 grid, as the company sent it. */
const grid = z.int().min(0).max(1000);
export const layerGridBoxSchema = z.tuple([grid, grid, grid, grid]);

// The words a model read on a text layer, with where each line sits and roughly how it looks. The
// limits are generous; the provider trims to them, so a long text never makes a layer unreadable.
export const LAYER_TEXT_MAX = 4000;
export const LAYER_TEXT_LINES_MAX = 100;
export const LAYER_TEXT_RUNS_MAX = 20;
export const LAYER_FONT_MAX = 100;

/** Roughly how a run of text looks. Every flag is the model's guess; false means it didn't see it. */
export const layerTextStyleSchema = z.object({
  /** The closest font the model knows. Absent when it couldn't tell. */
  font: z.string().min(1).max(LAYER_FONT_MAX).optional(),
  /** "#RRGGBB", upper case. */
  color: z
    .string()
    .regex(/^#[0-9A-F]{6}$/)
    .optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  shadow: z.boolean().optional(),
  translucent: z.boolean().optional(),
});

/** One line of a text layer, with the runs of one look it's made of. */
export const layerTextLineSchema = z.object({
  /** Where the line sits on the base, in pixels. */
  box: layerBoxSchema.optional(),
  boxGrid: layerGridBoxSchema.optional(),
  runs: z
    .array(z.object({ text: z.string().max(LAYER_TEXT_MAX), style: layerTextStyleSchema }))
    .max(LAYER_TEXT_RUNS_MAX),
});

/** A text layer's words: all of it, lines split by "\n", then line by line. */
export const layerTextSchema = z.object({
  text: z.string().max(LAYER_TEXT_MAX),
  lines: z.array(layerTextLineSchema).max(LAYER_TEXT_LINES_MAX),
});

/** What a row shows of a text layer: its words, cut short, and the first run's font and colour. */
export const LAYER_TEXT_SUMMARY_MAX = 300;
export const layerTextSummarySchema = z.object({
  text: z.string().max(LAYER_TEXT_SUMMARY_MAX),
  font: layerTextStyleSchema.shape.font,
  color: layerTextStyleSchema.shape.color,
});

/** The short form of a text layer's words, for a row or a canvas node. Null when there are none. */
export function layerTextSummary(text: LayerText | undefined | null): LayerTextSummary | null {
  const words = text?.text.trim();
  if (!text || !words) return null;
  // The first run that says what it is: a line can start with a run the model couldn't place.
  const runs = text.lines.flatMap((l) => l.runs);
  const font = runs.find((r) => r.style.font)?.style.font;
  const color = runs.find((r) => r.style.color)?.style.color;
  return {
    text: words.length > LAYER_TEXT_SUMMARY_MAX ? `${words.slice(0, LAYER_TEXT_SUMMARY_MAX - 1)}…` : words,
    ...(font && { font }),
    ...(color && { color }),
  };
}

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
  /** On a text layer, the words the model read and how they look (Seedream 5.5). */
  text: layerTextSchema.optional(),
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
  /** The most layers to make, on models that let you choose. Unset: the model's default. */
  maxLayers: layerCountSchema.optional(),
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
  /** The words on a text layer and how they look, or null. Read only: they're part of the image. */
  text: layerTextSchema.nullable(),
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
export type LayerText = z.infer<typeof layerTextSchema>;
export type LayerTextStyle = z.infer<typeof layerTextStyleSchema>;
export type LayerTextSummary = z.infer<typeof layerTextSummarySchema>;
export type LayersBody = z.input<typeof layersBodySchema>;
export type StackLayer = z.infer<typeof stackLayerSchema>;
export type LayerStackResponse = z.infer<typeof layerStackResponseSchema>;
export type StackEntry = z.infer<typeof stackEntrySchema>;
export type StackBody = z.infer<typeof stackBodySchema>;
export type LayerExportBody = z.infer<typeof layerExportBodySchema>;
export type FlattenResponse = z.infer<typeof flattenResponseSchema>;
