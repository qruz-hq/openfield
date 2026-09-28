import {
  BATCH_MAX,
  type CostEstimate,
  type ModelKey,
  type ModelListItem,
  type SizeSpec,
  VARIATION_STRATEGIES,
} from "@openfield/core";
import { estimateRun, type Resolved } from "@openfield/providers/manifest";
import { speedOf } from "../../engine/context-base";
import { scaleEstimate, sumEstimates } from "../../engine/cost";
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
  NodeBlocker,
  NodeEngine,
  PortSpec,
  ResolvedInputs,
  RunCall,
} from "../../engine/types";
import { carriedFor, newNodeSize, resolveFor, type SizeParams, wireSettings } from "../generate/settings";
import { readInt, readModel, readModels, readQuality, readResolution, readSize } from "../params";
import type { NodeSpec } from "../registry";

// Variations (design zodbS, Models mode mdu6t, M4-21): several takes of one image at once.
// New takes (same-prompt) repeats the same request; on a model that takes seeds the server picks a
// new one per image, which is M4-21's seed jitter (§0.11), and on the rest each take is a fresh
// try. Prompts runs one line each, Models the same request on each model. An image list coming in
// fans out: every image gets the whole set (§7.7).

export type VariationStrategy = (typeof VARIATION_STRATEGIES)[number];

export interface VariationsParams extends SizeParams {
  strategy: VariationStrategy;
  /** New takes: how many. */
  count: number;
  /** New takes and Prompts: the model. Unset follows the default. */
  model?: ModelKey;
  /** Models: one run each, in order. */
  models: ModelKey[];
  /** Prompts: one run per line, as typed (blank lines kept while editing). */
  prompts: string[];
}

/** A new card's box: four square takes (design njYDO). Its box then follows its images (card-size.ts). */
export const VARIATIONS_BOX = { w: 320, h: 320 } as const;

export const TAKES_MIN = 2;
export const TAKES_MAX = 8;
export const LIST_MIN = 2;
export const LIST_MAX = 8;

export const VARIATIONS_PORTS: readonly PortSpec[] = [
  {
    id: "image",
    label: "canvas.nodes.ports.image",
    direction: "in",
    type: "image",
    arity: "single",
    items: "one",
    required: false,
    binding: { to: "references", role: "subject" },
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
    id: "images",
    label: "canvas.nodes.ports.images",
    direction: "out",
    type: "image",
    arity: "single",
    items: "list",
    required: false,
  },
];

/** The prompt lines that count: trimmed, no blanks, at most eight. */
export const promptLines = (params: VariationsParams): string[] =>
  params.prompts
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, LIST_MAX);

/** The models that count: no repeats, at most eight. */
export const modelList = (params: VariationsParams): ModelKey[] =>
  [...new Set(params.models)].slice(0, LIST_MAX);

/** The prompt input, else the words that made the incoming image, else nothing (the image leads). */
function basePrompt(inputs: ResolvedInputs): string {
  const typed = joinPrompt(textOf(inputs, "prompt"));
  if (typed) return typed;
  const image = imagesOf(inputs, "image")[0];
  return image?.prompt?.trim() ?? "";
}

/** How many runs of the whole set: one per incoming image. */
export const fanOutOf = (inputs: ResolvedInputs): number =>
  Math.max(1, imageCount(imagesOf(inputs, "image")));

/** New takes split into requests of at most four (BATCH_MAX, or less where the model says so). */
export function takeBatches(count: number, model: ModelListItem): number[] {
  const per = Math.max(1, Math.min(BATCH_MAX, model.capabilities.batch.max));
  const out: number[] = [];
  for (let left = count; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}

interface Planned {
  calls: { call: RunCall; model: ModelListItem; resolved: Resolved }[];
}

function planCalls(node: EngineNode<VariationsParams>, inputs: ResolvedInputs, ctx: EngineContext): Planned {
  const p = node.params;
  const base = basePrompt(inputs);
  const settings = (model: ModelListItem, resolved: Resolved) => ({
    model: model.key,
    op: "variation" as const,
    ...wireSettings(model, resolved),
    seed: null,
  });

  if (p.strategy === "model-list") {
    return {
      calls: modelList(p).map((key) => {
        const model = ctx.model(key)!;
        const resolved = carriedFor(model, p);
        return { model, resolved, call: { ...settings(model, resolved), prompt: base, batch: 1 } };
      }),
    };
  }

  const model = ctx.model(modelKeyOf(p.model, ctx))!;
  const resolved = resolveFor(model, p, 1);
  if (p.strategy === "prompt-list") {
    const typed = joinPrompt(textOf(inputs, "prompt"));
    return {
      calls: promptLines(p).map((line) => ({
        model,
        resolved,
        call: { ...settings(model, resolved), prompt: joinPrompt([typed, line]), batch: 1, label: line },
      })),
    };
  }
  return {
    calls: takeBatches(p.count, model).map((batch) => ({
      model,
      resolved: { ...resolved, batch },
      call: { ...settings(model, resolved), prompt: base, batch },
    })),
  };
}

/** The models this node runs, in order. */
function modelsOf(p: VariationsParams, ctx: EngineContext): (ModelKey | null)[] {
  return p.strategy === "model-list" ? modelList(p) : [modelKeyOf(p.model, ctx)];
}

function fingerprintParams(node: EngineNode<VariationsParams>, ctx: EngineContext): FingerprintParams {
  const p = node.params;
  const settingsOf = (key: ModelKey | null) => {
    const model = ctx.model(key);
    if (!model) {
      return {
        model: key,
        manifestVersion: null,
        size: p.size ?? null,
        resolution: p.resolution ?? null,
        quality: p.quality ?? null,
      };
    }
    const resolved = p.strategy === "model-list" ? carriedFor(model, p) : resolveFor(model, p, 1);
    const wire = wireSettings(model, resolved);
    return {
      model: key,
      manifestVersion: model.manifestVersion,
      size: wire.size,
      resolution: wire.resolution ?? null,
      quality: wire.quality ?? null,
    };
  };
  const keys = modelsOf(p, ctx);
  const first = keys[0] ?? null;
  const strategy =
    p.strategy === "model-list"
      ? { models: keys.map(settingsOf) }
      : p.strategy === "prompt-list"
        ? { prompts: promptLines(p), settings: settingsOf(first) }
        : { count: p.count, settings: settingsOf(first) };
  return {
    params: { strategy: p.strategy, ...strategy },
    model: first,
    manifestVersion: ctx.model(first)?.manifestVersion ?? null,
    // Up to date while nothing it reads or sends changes, on models with seeds too: the server picks
    // new seeds only when it runs, so Run all keeps the takes it has. ⌥ on its Run makes new ones.
    cacheable: true,
  };
}

function blocker(
  node: EngineNode<VariationsParams>,
  inputs: ResolvedInputs,
  ctx: EngineContext,
): NodeBlocker | null {
  const p = node.params;
  const images = imageCount(imagesOf(inputs, "image"));
  if (p.strategy === "model-list" && modelList(p).length < LIST_MIN) {
    return { kind: "needs_more", what: "models", min: LIST_MIN };
  }
  if (p.strategy === "prompt-list" && promptLines(p).length < LIST_MIN) {
    return { kind: "needs_more", what: "prompts", min: LIST_MIN };
  }
  for (const key of modelsOf(p, ctx)) {
    const stop = modelBlocker(key, ctx);
    if (stop) return stop;
    // Each run takes one incoming image.
    const refs = referenceBlocker(ctx.model(key)!, images ? 1 : 0);
    if (refs) return refs;
  }
  if (!images && !basePrompt(inputs) && p.strategy !== "prompt-list") return { kind: "no_prompt" };
  return null;
}

export const variationsEngine: NodeEngine<VariationsParams> = {
  fingerprintParams,

  outputs(node, inputs, ctx, willRun) {
    const prompt = basePrompt(inputs);
    if (willRun) {
      const { calls } = planCalls(node, inputs, ctx);
      const expected = calls.reduce((sum, c) => sum + c.call.batch, 0) * fanOutOf(inputs);
      return { images: [{ kind: "pending", nodeId: node.id, port: "images", expected, prompt }] };
    }
    return {
      images: (node.result?.assetIds ?? []).map((assetId) => ({ kind: "asset" as const, assetId, prompt })),
    };
  },

  blocker,

  compile(node, inputs, ctx, fingerprint) {
    const { calls } = planCalls(node, inputs, ctx);
    const k = fanOutOf(inputs);
    const images = imagesOf(inputs, "image");
    // Each run sends in one incoming image, the one it fans out over.
    const inputImages = images.length ? 1 : 0;
    const estimates: CostEstimate[] = calls.map(({ model, resolved, call }) =>
      estimateRun(
        model,
        { ...resolved, batch: call.batch },
        call.prompt,
        speedOf(ctx, model),
        { inputImages },
        ctx.askPrice,
      ),
    );
    const jobs = calls.reduce((sum, c) => sum + c.call.batch, 0) * k;
    return {
      ok: true,
      node: {
        item: {
          nodeId: node.id,
          type: node.type,
          typeVersion: node.typeVersion,
          fingerprint,
          model: calls[0]!.call.model,
          params: fingerprintParams(node, ctx).params as Record<string, unknown>,
          inputs: images.length
            ? [
                {
                  port: "image",
                  to: "references",
                  role: "subject",
                  arity: "single",
                  values: images.map(planValue),
                },
              ]
            : [],
          calls: calls.map((c) => c.call),
          cached: null,
        },
        expectedJobs: jobs,
        estimate: scaleEstimate(sumEstimates(estimates), k),
        fanOut: k,
      },
    };
  },
};

/** Documents from before the rename call New takes "seed-jitter". */
const readStrategy = (value: unknown): VariationStrategy =>
  (VARIATION_STRATEGIES as readonly unknown[]).includes(value) ? (value as VariationStrategy) : "same-prompt";

export const variationsSpec: NodeSpec<VariationsParams> = {
  type: "image.variations",
  typeVersion: 1,
  label: "canvas.nodes.variations.label",
  description: "canvas.nodes.variations.description",
  keywords: ["takes", "compare", "models", "prompts", "several"],
  category: "generate",
  menu: { group: "image", order: 2 },
  // An image card like Generate's: the editor gives it the box of its images (card-size.ts).
  size: { ...VARIATIONS_BOX },
  resizable: false,
  annotation: false,
  ports: VARIATIONS_PORTS,
  defaults: (ctx) => ({
    strategy: "same-prompt",
    count: 4,
    ...(ctx.defaultModel && { model: ctx.defaultModel }),
    ...newNodeSize(ctx),
    models: [],
    prompts: [],
  }),
  parseParams: (raw) => ({
    strategy: readStrategy(raw.strategy),
    count: readInt(raw, "count", TAKES_MIN, TAKES_MAX, 4),
    model: readModel(raw.model),
    models: readModels(raw.models),
    prompts: Array.isArray(raw.prompts) ? raw.prompts.filter((l): l is string => typeof l === "string") : [],
    size: readSize(raw.size) as SizeSpec | undefined,
    resolution: readResolution(raw.resolution),
    quality: readQuality(raw.quality),
  }),
  runnable: true,
  engine: variationsEngine,
};
