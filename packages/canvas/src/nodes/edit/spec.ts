import {
  type CompositeSettings,
  MASK_COMPOSITE_DEFAULTS,
  MASK_COMPOSITE_MAX_PX,
  type ModelKey,
  type ModelListItem,
  type ResolutionTier,
  type SizeSpec,
} from "@openfield/core";
import { editsImages, estimate, type Resolved } from "@openfield/providers/manifest";
import { speedOf } from "../../engine/context-base";
import { scaleEstimate } from "../../engine/cost";
import {
  type ImageValue,
  imageCount,
  imagesOf,
  joinPrompt,
  modelBlocker,
  modelsForEdit,
  planValue,
  referenceBlocker,
  textOf,
} from "../../engine/inputs";
import type {
  EngineContext,
  EngineNode,
  FingerprintParams,
  NodeEngine,
  PortSpec,
  PortValue,
  ResolvedInputs,
  RunCall,
  RunInput,
} from "../../engine/types";
import { CARD_WIDTH, imageCardBox } from "../generate/card-size";
import { resolveFor } from "../generate/settings";
import { pinnedSeed } from "../generate/spec";
import {
  readAssetId,
  readBatch,
  readBoolean,
  readInt,
  readModel,
  readQuality,
  readRecord,
  readResolution,
  readSeed,
  readString,
  type SeedParam,
} from "../params";
import type { NodeSpec } from "../registry";

// Edit (image.edit, design nRuORN2ZyA): changes an image where its mask says, and keeps the rest.
// The image comes in on its own input, the mask is painted in the node or comes in on the Mask
// input, and words come from upstream plus the node's own. The result keeps the image's shape: the
// server asks for the base's size (an "auto" size, runner withEditSize), so there's no aspect here.
// A model that takes a mask gets it (an inpaint); one that only redraws the whole image never sees
// it. Either way the mask goes with the run, and the server puts back what's outside it afterwards
// (§0.9), as for the detail view's Edit tab.

export interface EditParams {
  model?: ModelKey;
  /** The node's own words, after anything upstream. */
  prompt: string;
  /** The mask painted in the node (a mask asset). A mask on the Mask input is used instead. */
  maskAssetId?: string;
  /** The image the painted mask was painted on. It fits only that one. */
  maskFor?: string;
  /** Put the original back outside the mask ("Keep the rest of the image"). */
  keepOriginal: boolean;
  /** Soften the mask's edge over this many pixels. */
  featherPx: number;
  /** Grow the mask by this many pixels first. */
  expandPx: number;
  /** Unset: the model's default, as the chip shows. */
  resolution?: ResolutionTier;
  /** Unset: the model's default. */
  quality?: string;
  batch: number;
  seed: SeedParam;
  providerOptions: Record<string, unknown>;
}

export const EDIT_PORTS: readonly PortSpec[] = [
  {
    id: "image",
    label: "canvas.nodes.ports.image",
    direction: "in",
    type: "image",
    arity: "single",
    items: "one",
    required: true,
    binding: { to: "base" },
  },
  {
    id: "mask",
    label: "canvas.nodes.ports.mask",
    direction: "in",
    type: "mask",
    arity: "single",
    items: "one",
    required: false,
    binding: { to: "mask" },
  },
  {
    id: "prompt",
    label: "canvas.nodes.ports.prompt",
    direction: "in",
    type: "text",
    arity: "single",
    items: "one",
    required: false,
    binding: { to: "prompt" },
  },
  {
    id: "input_images",
    label: "canvas.nodes.ports.referenceImages",
    direction: "in",
    type: "image",
    arity: "multi",
    items: "one",
    required: false,
    binding: { to: "references", role: "subject" },
  },
  {
    id: "images",
    label: "canvas.nodes.ports.images",
    direction: "out",
    type: "image",
    arity: "single",
    items: "list",
    required: false,
  },
];

/** The model an Edit node asks for, or the one edits start on when it names none. */
export const editModelKeyOf = (key: ModelKey | undefined, ctx: EngineContext): ModelKey | null =>
  key ?? ctx.defaultEditModel ?? null;

/** Upstream words, then the node's own. */
export const editPrompt = (node: EngineNode<EditParams>, inputs: ResolvedInputs): string =>
  joinPrompt([...textOf(inputs, "prompt"), node.params.prompt]);

/** The images the image input stands for now: its own, or those its node has before it runs again. */
const baseNow = (inputs: ResolvedInputs): string[] =>
  imagesOf(inputs, "image").flatMap((v) => (v.kind === "asset" ? [v.assetId] : [...(v.current ?? [])]));

/** The Mask input holds the node's own painted mask: nothing is connected there. */
function painted(node: EngineNode<EditParams>, inputs: ResolvedInputs): boolean {
  const [only, ...rest] = imagesOf(inputs, "mask");
  return (
    !!node.params.maskAssetId &&
    rest.length === 0 &&
    only?.kind === "asset" &&
    only.assetId === node.params.maskAssetId
  );
}

/**
 * Whether the painted mask still fits the image coming in. It was painted on one image (maskFor),
 * so over another one, or several, it would change the wrong place ("The image changed").
 */
export function paintedMaskFits(node: EngineNode<EditParams>, inputs: ResolvedInputs): boolean {
  if (!painted(node, inputs) || !node.params.maskFor) return true;
  const now = baseNow(inputs);
  return now.length === 1 && now[0] === node.params.maskFor;
}

/** The mask a run sends: none while a painted one doesn't fit the image. */
const sentMask = (node: EngineNode<EditParams>, inputs: ResolvedInputs): ImageValue[] =>
  paintedMaskFits(node, inputs) ? imagesOf(inputs, "mask") : [];

/** A list into the image or the Mask input runs the node once per image, as any single input does. */
const fanOutOf = (node: EngineNode<EditParams>, inputs: ResolvedInputs): number =>
  Math.max(1, imageCount(imagesOf(inputs, "image"))) * Math.max(1, imageCount(sentMask(node, inputs)));

/** The keep-the-rest settings a run sends with its mask. */
const compositeOf = (p: EditParams): CompositeSettings => ({
  composite: p.keepOriginal,
  expandPx: p.expandPx,
  featherPx: p.featherPx,
});

/**
 * The size, tier and quality an edit sends. "auto" asks for the base's shape, which the server reads
 * from the base, at the tier the chip shows (the model's default until one is picked), as the Edit
 * tab sends it.
 */
function editWire(model: ModelListItem, resolved: Resolved) {
  const caps = model.capabilities;
  const size: SizeSpec = { kind: "auto" };
  return {
    size,
    ...(caps.resolution && resolved.resolution && { resolution: resolved.resolution }),
    ...(caps.quality && resolved.quality && { quality: resolved.quality }),
  };
}

function fingerprintParams(node: EngineNode<EditParams>, ctx: EngineContext): FingerprintParams {
  const p = node.params;
  const key = editModelKeyOf(p.model, ctx);
  const model = ctx.model(key);
  // The image and a connected mask count through their own fingerprints; a painted one is here.
  // Growing and softening only matter while the original is put back.
  const common = {
    prompt: p.prompt.trim(),
    mask: p.maskAssetId ?? null,
    composite: p.keepOriginal ? { expandPx: p.expandPx, featherPx: p.featherPx } : false,
    providerOptions: p.providerOptions,
  };
  if (!model) {
    return {
      params: {
        ...common,
        resolution: p.resolution ?? null,
        quality: p.quality ?? null,
        batch: p.batch,
        seed: p.seed.mode === "fixed" ? (p.seed.value ?? 0) : "random",
      },
      model: key,
      manifestVersion: null,
      cacheable: true,
    };
  }
  // Unset and "set to the default" resolve to the same values, so they hash the same.
  const resolved = resolveFor(model, p, p.batch);
  const wire = editWire(model, resolved);
  const seed = pinnedSeed(model, p.seed);
  return {
    params: {
      ...common,
      resolution: wire.resolution ?? null,
      quality: wire.quality ?? null,
      batch: resolved.batch,
      seed: seed ?? "random",
    },
    model: key,
    manifestVersion: model.manifestVersion,
    // A model with seeds gives a new image per run unless one is pinned.
    cacheable: !(model.capabilities.seed.supported && seed === null),
  };
}

export const editEngine: NodeEngine<EditParams> = {
  fingerprintParams,

  // The painted mask, while nothing is connected to the Mask input.
  inlineInputs(node): Record<string, PortValue[]> {
    const mask = node.params.maskAssetId;
    return mask ? { mask: [{ kind: "asset", assetId: mask }] } : {};
  },

  outputs(node, inputs, ctx, willRun) {
    const prompt = editPrompt(node, inputs);
    if (willRun) {
      const model = ctx.model(editModelKeyOf(node.params.model, ctx));
      const batch = model ? resolveFor(model, node.params, node.params.batch).batch : node.params.batch;
      const expected = batch * fanOutOf(node, inputs);
      return { images: [{ kind: "pending", nodeId: node.id, port: "images", expected, prompt }] };
    }
    return {
      images: (node.result?.assetIds ?? []).map((assetId) => ({ kind: "asset" as const, assetId, prompt })),
    };
  },

  blocker(node, inputs, ctx) {
    const key = editModelKeyOf(node.params.model, ctx);
    const stop = modelBlocker(key, ctx);
    if (stop) return stop;
    const model = ctx.model(key)!;
    // A model that can't edit is as good as missing here, as a video model is.
    if (!editsImages(model.capabilities)) return { kind: "model_unavailable", model: model.key };
    // What the person has to fix whatever else is missing comes first (STANDING_BLOCKERS).
    const references = referenceBlocker(model, imageCount(imagesOf(inputs, "input_images")));
    if (references) return references;
    if (imageCount(imagesOf(inputs, "image")) === 0) return { kind: "missing_input", port: "image" };
    if (imageCount(imagesOf(inputs, "mask")) === 0) return { kind: "no_mask" };
    if (!paintedMaskFits(node, inputs)) return { kind: "mask_stale" };
    if (painted(node, inputs) && ctx.missing?.has(node.params.maskAssetId!)) return { kind: "missing_asset" };
    // An area to change comes before words for it, as on the Edit tab.
    if (!editPrompt(node, inputs)) return { kind: "no_description" };
    return null;
  },

  compile(node, inputs, ctx, fingerprint) {
    const key = editModelKeyOf(node.params.model, ctx)!;
    const model = ctx.model(key)!;
    const p = node.params;
    const prompt = editPrompt(node, inputs);
    const resolved = resolveFor(model, p, p.batch);
    const base = imagesOf(inputs, "image");
    const mask = sentMask(node, inputs);
    const references = imagesOf(inputs, "input_images");
    // As the server decides (core adapterOpFor): an inpaint where the model takes the mask, else a
    // whole-image edit. The mask goes either way, so the server can put back what's outside it.
    const op = mask.length > 0 && model.capabilities.ops.inpaint ? "inpaint" : "edit";
    const wire = editWire(model, resolved);
    const call: RunCall = {
      model: key,
      op,
      prompt,
      ...wire,
      batch: resolved.batch,
      seed: pinnedSeed(model, p.seed),
      ...(mask.length > 0 && { mask: compositeOf(p) }),
      ...(Object.keys(p.providerOptions).length && { providerOptions: p.providerOptions }),
    };
    const inputsSent: RunInput[] = [
      ...(base.length
        ? [{ port: "image", to: "base" as const, arity: "single" as const, values: base.map(planValue) }]
        : []),
      ...(mask.length
        ? [{ port: "mask", to: "mask" as const, arity: "single" as const, values: mask.map(planValue) }]
        : []),
      ...(references.length
        ? [
            {
              port: "input_images",
              to: "references" as const,
              role: "subject" as const,
              arity: "multi" as const,
              values: references.map(planValue),
            },
          ]
        : []),
    ];
    const fanOut = fanOutOf(node, inputs);
    // Priced as the server prices the plan: the base and every reference are billed as images sent
    // in, the mask never is.
    const once = estimate(model, {
      op,
      batch: resolved.batch,
      prompt,
      speed: speedOf(ctx, model, op),
      ...(wire.resolution && { resolution: wire.resolution }),
      ...(wire.quality && { quality: wire.quality }),
      inputImages: (base.length ? 1 : 0) + imageCount(references),
    });
    return {
      ok: true,
      node: {
        item: {
          nodeId: node.id,
          type: node.type,
          typeVersion: node.typeVersion,
          fingerprint,
          model: key,
          params: fingerprintParams(node, ctx).params as Record<string, unknown>,
          inputs: inputsSent,
          calls: [call],
          cached: null,
        },
        expectedJobs: resolved.batch * fanOut,
        estimate: scaleEstimate(once, fanOut),
        fanOut,
      },
    };
  },
};

export const editSpec: NodeSpec<EditParams> = {
  type: "image.edit",
  typeVersion: 1,
  label: "canvas.nodes.edit.label",
  description: "canvas.nodes.edit.description",
  keywords: ["image", "edit", "mask", "inpaint", "change", "fix", "retouch", "paint"],
  category: "edit",
  menu: { group: "image", order: 1 },
  // Some image model has to edit, with a mask or over the whole image.
  listed: (ctx) => {
    const { masked, whole } = modelsForEdit(ctx.models);
    return masked.length + whole.length > 0;
  },
  // Square until it has an image, like Generate on auto; the editor's box then follows the image.
  size: { w: CARD_WIDTH, h: CARD_WIDTH },
  resizable: false,
  imageBox: imageCardBox,
  annotation: false,
  ports: EDIT_PORTS,
  defaults: (ctx) => ({
    ...(ctx.defaultEditModel && { model: ctx.defaultEditModel }),
    prompt: "",
    keepOriginal: MASK_COMPOSITE_DEFAULTS.composite,
    featherPx: MASK_COMPOSITE_DEFAULTS.featherPx,
    expandPx: MASK_COMPOSITE_DEFAULTS.expandPx,
    batch: ctx.defaultBatch ?? 1,
    seed: { mode: "random" },
    providerOptions: {},
  }),
  parseParams: (raw) => ({
    model: readModel(raw.model),
    prompt: readString(raw, "prompt"),
    maskAssetId: readAssetId(raw.maskAssetId),
    maskFor: readAssetId(raw.maskFor),
    keepOriginal: readBoolean(raw, "keepOriginal", MASK_COMPOSITE_DEFAULTS.composite),
    featherPx: readInt(raw, "featherPx", 0, MASK_COMPOSITE_MAX_PX, MASK_COMPOSITE_DEFAULTS.featherPx),
    expandPx: readInt(raw, "expandPx", 0, MASK_COMPOSITE_MAX_PX, MASK_COMPOSITE_DEFAULTS.expandPx),
    resolution: readResolution(raw.resolution),
    quality: readQuality(raw.quality),
    batch: readBatch(raw.batch, 1),
    seed: readSeed(raw.seed),
    providerOptions: readRecord(raw.providerOptions),
  }),
  runnable: true,
  engine: editEngine,
};
