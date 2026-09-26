import type { ModelKey, ModelListItem, SizeSpec } from "@openfield/core";
import { Sparkles } from "lucide-react";
import { estimateRun } from "../../../lib/controls";
import { speedOf } from "../../engine/context-base";
import {
  imageCount,
  imagesOf,
  joinPrompt,
  modelBlocker,
  modelKeyOf,
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
  ResolvedInputs,
  RunCall,
} from "../../engine/types";
import {
  type NodeSpec,
  readBatch,
  readBoolean,
  readModel,
  readQuality,
  readRecord,
  readResolution,
  readSeed,
  readSize,
  readString,
  type SeedParam,
} from "../params";
import { cardMedia } from "./card-media";
import { CARD_WIDTH, cardLayout, restBox, restKey } from "./card-size";
import { newNodeSize, resolveFor, type SizeParams, wireSettings } from "./settings";

// Generate (design Y5jjx): the canvas's composer. A prompt from upstream plus its own text,
// reference images in connection order, and the model's settings (in the inspector). The node is
// an image card whose box follows its image, or the chosen aspect ratio before there is one.
// Style waits for M4-20.

export interface GenerateParams extends SizeParams {
  model?: ModelKey;
  /** The node's own text, after anything upstream ("Add to the prompt"). */
  prompt: string;
  batch: number;
  seed: SeedParam;
  enhancePrompt: boolean;
  providerOptions: Record<string, unknown>;
}

export const GENERATE_PORTS: readonly PortSpec[] = [
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
  // The Style node (M4-20) turns this on. Until then its slot stays empty, so Prompt sits 36 above
  // the middle and Reference images level with the output (design Y5jjx).
  {
    id: "preset",
    label: "canvas.nodes.ports.style",
    direction: "in",
    type: "preset",
    arity: "single",
    items: "one",
    required: false,
    hidden: true,
    keepSlot: true,
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

/** Upstream text, then the node's own. */
export const generatePrompt = (node: EngineNode<GenerateParams>, inputs: ResolvedInputs): string =>
  joinPrompt([...textOf(inputs, "prompt"), node.params.prompt]);

/** A pinned seed, only where the model takes seeds (§0.11). */
export function pinnedSeed(model: ModelListItem | undefined, seed: SeedParam): number | null {
  return model?.capabilities.seed.supported && seed.mode === "fixed" ? (seed.value ?? 0) : null;
}

function fingerprintParams(node: EngineNode<GenerateParams>, ctx: EngineContext): FingerprintParams {
  const p = node.params;
  const key = modelKeyOf(p.model, ctx);
  const model = ctx.model(key);
  const common = {
    prompt: p.prompt.trim(),
    enhancePrompt: p.enhancePrompt,
    providerOptions: p.providerOptions,
  };
  if (!model) {
    return {
      params: {
        ...common,
        size: p.size ?? null,
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
  const wire = wireSettings(model, resolved);
  const seed = pinnedSeed(model, p.seed);
  return {
    params: {
      ...common,
      size: wire.size,
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

export const generateEngine: NodeEngine<GenerateParams> = {
  fingerprintParams,

  outputs(node, inputs, ctx, willRun) {
    const prompt = generatePrompt(node, inputs);
    if (willRun) {
      const model = ctx.model(modelKeyOf(node.params.model, ctx));
      const expected = model ? resolveFor(model, node.params, node.params.batch).batch : node.params.batch;
      return { images: [{ kind: "pending", nodeId: node.id, port: "images", expected, prompt }] };
    }
    return {
      images: (node.result?.assetIds ?? []).map((assetId) => ({ kind: "asset" as const, assetId, prompt })),
    };
  },

  blocker(node, inputs, ctx) {
    const key = modelKeyOf(node.params.model, ctx);
    const stop = modelBlocker(key, ctx);
    if (stop) return stop;
    const count = imageCount(imagesOf(inputs, "input_images"));
    // Either words or at least one reference image (normalize() takes either).
    if (!generatePrompt(node, inputs) && count === 0) return { kind: "no_prompt" };
    return referenceBlocker(ctx.model(key)!, count);
  },

  compile(node, inputs, ctx, fingerprint) {
    const key = modelKeyOf(node.params.model, ctx)!;
    const model = ctx.model(key)!;
    const p = node.params;
    const prompt = generatePrompt(node, inputs);
    const resolved = resolveFor(model, p, p.batch);
    const images = imagesOf(inputs, "input_images");
    const call: RunCall = {
      model: key,
      op: "generate",
      prompt,
      ...wireSettings(model, resolved),
      batch: resolved.batch,
      seed: pinnedSeed(model, p.seed),
      ...(p.enhancePrompt && { enhancePrompt: true }),
      ...(Object.keys(p.providerOptions).length && { providerOptions: p.providerOptions }),
    };
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
          inputs: images.length
            ? [
                {
                  port: "input_images",
                  to: "references",
                  role: "subject",
                  arity: "multi",
                  values: images.map(planValue),
                },
              ]
            : [],
          calls: [call],
          cached: null,
        },
        expectedJobs: resolved.batch,
        estimate: estimateRun(model, resolved, prompt, speedOf(ctx, model)),
        fanOut: 1,
      },
    };
  },
};

export const generateSpec: NodeSpec<GenerateParams> = {
  type: "image.generate",
  typeVersion: 1,
  label: "canvas.nodes.generate.label",
  description: "canvas.nodes.generate.description",
  keywords: ["image", "create", "model", "make"],
  icon: Sparkles,
  category: "generate",
  menu: { group: "image", order: 0 },
  // Auto's square, until the node has an aspect ratio or an image (card-size.ts).
  size: { w: CARD_WIDTH, h: CARD_WIDTH },
  resizable: false,
  box: ({ frame, params, result, ctx }) => {
    const { w, h } = cardLayout({ frame, params, result, ctx, media: cardMedia.getState() });
    return { w, h };
  },
  rest: {
    key: ({ params, result }) => restKey(params, result),
    box: (input) => restBox(input, cardMedia.getState()),
  },
  annotation: false,
  ports: GENERATE_PORTS,
  defaults: (ctx) => ({
    ...(ctx.defaultModel && { model: ctx.defaultModel }),
    ...newNodeSize(ctx),
    prompt: "",
    batch: ctx.defaultBatch ?? 1,
    seed: { mode: "random" },
    enhancePrompt: false,
    providerOptions: {},
  }),
  parseParams: (raw) => ({
    model: readModel(raw.model),
    prompt: readString(raw, "prompt"),
    size: readSize(raw.size) as SizeSpec | undefined,
    resolution: readResolution(raw.resolution),
    quality: readQuality(raw.quality),
    batch: readBatch(raw.batch, 1),
    seed: readSeed(raw.seed),
    enhancePrompt: readBoolean(raw, "enhancePrompt"),
    providerOptions: readRecord(raw.providerOptions),
  }),
  runnable: true,
  engine: generateEngine,
};
