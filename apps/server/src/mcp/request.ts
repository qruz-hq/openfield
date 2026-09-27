import {
  ASPECT_RATIOS,
  BATCH_MAX,
  type GenerateRequest,
  type ModelKey,
  newId,
  RESOLUTION_TIERS,
  type SizeSpec,
} from "@openfield/core";
import { z } from "zod";
import { Refusal, type ToolContext } from "./kit";
import { IMAGE_REF_HINT, resolveImage } from "./refs";

// What an agent asks for when it makes or edits an image, and the request the runner gets for it.
// The runner's own checks (normalize) still decide what each model can do.

export const imageRequestFields = {
  prompt: z.string().min(1).max(32_000).describe("What to make, or for an edit, what to change."),
  model: z
    .string()
    .optional()
    .describe(
      'A model from list_models, by key ("google:gemini-3-pro-image") or name ("Nano Banana Pro"). Default: the person\'s default model.',
    ),
  aspect: z
    .enum(ASPECT_RATIOS)
    .optional()
    .describe(
      'Aspect ratio, such as "1:1", "3:4" or "16:9". Default: the person\'s default, else the model\'s.',
    ),
  size: z
    .object({ width: z.int().min(64).max(16_384), height: z.int().min(64).max(16_384) })
    .optional()
    .describe("Exact pixel size, for models that take one. Use aspect otherwise."),
  resolution: z.enum(RESOLUTION_TIERS).optional().describe("Resolution tier, such as 1K, 2K or 4K."),
  quality: z.string().optional().describe("A quality id the model lists in list_models."),
  count: z
    .int()
    .min(1)
    .max(BATCH_MAX)
    .optional()
    .describe(`How many images, 1 to ${BATCH_MAX}. Each one is billed. Default: the person's default.`),
  seed: z.int().min(0).max(2_147_483_647).optional().describe("A seed, for models that take one."),
  negativePrompt: z.string().max(4_000).optional().describe("What to leave out, for models that take it."),
  references: z
    .array(z.string())
    .max(16)
    .optional()
    .describe(`Reference images the model follows. Each one: ${IMAGE_REF_HINT}`),
  edit: z
    .object({
      image: z.string().describe(`The image to change. ${IMAGE_REF_HINT}`),
      mask: z
        .string()
        .optional()
        .describe(
          "Optional: a PNG the same size as the image, transparent where it should change. Only models that can inpaint take one.",
        ),
    })
    .optional()
    .describe("Change an existing image instead of making a new one. The prompt says what to change."),
};

type ImageRequestArgs = {
  [K in keyof typeof imageRequestFields]?: z.output<(typeof imageRequestFields)[K]>;
} & { prompt: string };

/** The model an agent named, or the person's default, or the first one that's ready. */
export function pickModel(ctx: ToolContext, requested: string | undefined): ModelKey {
  const { models } = ctx.svc.models.list();
  if (requested) {
    const wanted = requested.trim().toLowerCase();
    const model = models.find(
      (m) =>
        m.key.toLowerCase() === wanted ||
        m.modelId.toLowerCase() === wanted ||
        m.displayName.toLowerCase() === wanted,
    );
    if (!model) throw new Refusal(`There's no model called "${requested}". Call list_models to see them.`);
    if (!model.enabled)
      throw new Refusal(`${model.displayName} is turned off in Openfield, Settings > Models.`);
    if (!model.ready) {
      throw new Refusal(
        `${model.displayName} needs a key. The person can add one in Openfield, Settings > API keys.`,
      );
    }
    return model.key;
  }
  const usable = models.filter((m) => m.ready && m.enabled && !ctx.svc.models.early(m.providerId));
  const preferred = ctx.svc.settings.get().defaultModel;
  const model = usable.find((m) => m.key === preferred) ?? usable[0];
  if (!model) {
    throw new Refusal(
      "No model is ready yet. The person needs to add a key in Openfield, Settings > API keys.",
    );
  }
  return model.key;
}

/** Brings in any images the request points at, then builds what the runner takes. */
export async function buildRequest(ctx: ToolContext, args: ImageRequestArgs): Promise<GenerateRequest> {
  const settings = ctx.svc.settings.get();
  const model = pickModel(ctx, args.model);
  const references = [];
  for (const ref of args.references ?? []) references.push(await resolveImage(ctx, ref));
  const base = args.edit ? await resolveImage(ctx, args.edit.image) : undefined;
  const mask = args.edit?.mask ? await resolveImage(ctx, args.edit.mask) : undefined;
  const aspect = args.aspect ?? settings.defaultAspect;
  const size: SizeSpec = args.size
    ? { kind: "pixels", width: args.size.width, height: args.size.height }
    : aspect && aspect !== "auto"
      ? { kind: "aspect", ratio: aspect }
      : { kind: "auto" };
  return {
    idempotencyKey: newId(),
    model,
    op: base ? (mask ? "inpaint" : "edit") : "generate",
    prompt: args.prompt,
    ...(args.negativePrompt && { negativePrompt: args.negativePrompt }),
    size,
    ...(args.resolution && { resolution: args.resolution }),
    ...(args.quality && { quality: args.quality }),
    batch: args.count ?? settings.defaultBatch,
    ...(args.seed !== undefined && { seed: args.seed }),
    ...(references.length > 0 && {
      references: references.map((r) => ({ assetId: r.id, role: "subject" as const })),
    }),
    ...(base && { base: { assetId: base.id, role: "base" as const } }),
    ...(mask && { mask: { assetId: mask.id } }),
    source: "api",
  };
}
