import {
  LAYER_SIZES,
  LAYERS_MAX,
  type LayerSize,
  type ModelKey,
  type ModelListItem,
  modalityOf,
  t,
} from "@openfield/core";
import type { CanvasNodeResult, CanvasOutput } from "@openfield/core/canvas";
import { estimate } from "@openfield/providers/manifest";
import { speedOf } from "../../engine/context-base";
import { imageCount, imagesNow, imagesOf, layerPortId, modelBlocker, planValue } from "../../engine/inputs";
import type {
  EngineContext,
  FingerprintParams,
  NodeEngine,
  PortSpec,
  PortValue,
  RunCall,
} from "../../engine/types";
import type { Size } from "../../store/ops";
import { readModel, readString } from "../params";
import type { NodeBoxInput, NodeSpec, PortNode } from "../registry";

// Layers (image.layers, design AvNxGiFbq7): splits the image coming in into a base and separate
// transparent layers, as the detail view's Layers tab does (POST /api/layers, op "decompose"). After
// a run it has one image output per layer, top layer first and the base last, each named by the
// model. An output is keyed by the layer's place in the stack ("layer-3", "base"), so a link stays
// on the same place when it runs again. A port whose layer the last run didn't make stays drawn,
// dimmed, while something is linked to it: it hands on nothing, and what reads it says so.

export interface LayersParams {
  model?: ModelKey;
  /** Which parts to separate, in words. Empty: the model picks the main elements. */
  prompt: string;
  /** Unset: the model's default. */
  size?: LayerSize;
}

/** Design: 320 wide, the image 240 tall, then one 40 tall row per output between 4 px of padding. */
export const LAYERS_WIDTH = 320;
export const LAYERS_MEDIA_HEIGHT = 240;
export const LAYERS_ROW_HEIGHT = 40;
export const LAYERS_ROWS_PAD = 4;
/** Before a run the rows are one 48 tall hint ("Layers show up here after a run."). */
export const LAYERS_EMPTY_FOOT = 48;

export const LAYERS_INPUT: PortSpec = {
  id: "image",
  label: "canvas.nodes.ports.image",
  direction: "in",
  type: "image",
  arity: "single",
  items: "one",
  required: true,
  binding: { to: "base" },
};

const output = (id: string, label: PortSpec["label"]): PortSpec => ({
  id,
  label,
  direction: "out",
  type: "image",
  arity: "single",
  items: "one",
  required: false,
});

/** Every output a Layers node can have: the top place first, the base last. */
export const LAYERS_OUTPUTS: readonly PortSpec[] = [
  ...Array.from({ length: LAYERS_MAX }, (_, i) =>
    output(`layer-${LAYERS_MAX - i}`, "canvas.nodes.ports.layer"),
  ),
  output("base", "canvas.nodes.ports.base"),
];

export const LAYERS_PORTS: readonly PortSpec[] = [LAYERS_INPUT, ...LAYERS_OUTPUTS];

/** Place in the stack of an output port: 0 for the base. */
const placeOf = (port: string): number => (port === "base" ? 0 : Number(port.slice("layer-".length)));

/** What the last run made, by output port: the layer's own name and description. */
export function layerOutputs(result: CanvasNodeResult | null): Map<string, CanvasOutput> {
  const out = new Map<string, CanvasOutput>();
  for (const o of result?.outputs ?? []) if (o.layer) out.set(layerPortId(o.layer), o);
  return out;
}

/** A layer's name as its row and port show it: the model's, else "Layer 3" or "Base". */
export function layerName(port: string, made: CanvasOutput | undefined): string {
  const name = made?.layer?.name?.trim();
  if (name) return name;
  return port === "base" ? t("layers.base") : t("layers.layer", { n: placeOf(port) });
}

/**
 * The outputs one node shows, top first and the base last: each layer the last run made, and any
 * other place something is still linked to (`gone`). Before a run, none.
 */
export function layerRows(node: Pick<PortNode, "result" | "linked">): PortSpec[] {
  const made = layerOutputs(node.result);
  const linked = node.linked();
  const ids = new Set([
    ...made.keys(),
    ...[...linked].filter((id) => LAYERS_OUTPUTS.some((p) => p.id === id)),
  ]);
  return LAYERS_OUTPUTS.filter((p) => ids.has(p.id)).map((p, i) => ({
    ...p,
    name: layerName(p.id, made.get(p.id)),
    top: LAYERS_MEDIA_HEIGHT + LAYERS_ROWS_PAD + LAYERS_ROW_HEIGHT / 2 + i * LAYERS_ROW_HEIGHT,
    ...(!made.has(p.id) && { gone: true }),
  }));
}

/** The card's height for this many rows. */
export const layersHeight = (rows: number): number =>
  LAYERS_MEDIA_HEIGHT + (rows > 0 ? 2 * LAYERS_ROWS_PAD + rows * LAYERS_ROW_HEIGHT : LAYERS_EMPTY_FOOT);

/** Image models that split images into layers. */
export const layerCapable = (m: ModelListItem): boolean =>
  modalityOf(m) === "image" && m.capabilities.ops.decomposeLayers && m.capabilities.layers !== undefined;

/** The model a Layers node asks for, or the one it starts on: the default model when it splits. */
export function layersModelKeyOf(key: ModelKey | undefined, ctx: EngineContext): ModelKey | null {
  if (key) return key;
  const capable = ctx.models.filter(layerCapable);
  const fallback =
    capable.find((m) => m.key === ctx.defaultModel) ?? capable.find((m) => m.ready) ?? capable[0];
  return fallback?.key ?? null;
}

/** The size a run asks for: the one picked where the model has it, else the model's default. */
export function layerSizeOf(model: ModelListItem | undefined, size: LayerSize | undefined): LayerSize {
  const rules = model?.capabilities.layers;
  if (!rules) return size ?? "auto";
  return size && rules.sizes.includes(size) ? size : rules.default;
}

function fingerprintParams(node: { params: LayersParams }, ctx: EngineContext): FingerprintParams {
  const key = layersModelKeyOf(node.params.model, ctx);
  const model = ctx.model(key);
  return {
    params: { prompt: node.params.prompt.trim(), size: layerSizeOf(model, node.params.size) },
    model: key,
    manifestVersion: model?.manifestVersion ?? null,
    // The same image and settings split the same way, near enough: never split again for nothing.
    cacheable: true,
  };
}

export const layersEngine: NodeEngine<LayersParams> = {
  fingerprintParams,

  outputs(node, _inputs, _ctx, willRun) {
    if (willRun) {
      // How many layers come back is the model's call: each place is one image if it does.
      return Object.fromEntries(
        LAYERS_OUTPUTS.map((p): [string, PortValue[]] => [
          p.id,
          [{ kind: "pending", nodeId: node.id, port: p.id, expected: 1 }],
        ]),
      );
    }
    const made = layerOutputs(node.result);
    return Object.fromEntries(
      LAYERS_OUTPUTS.map((p): [string, PortValue[]] => {
        const o = made.get(p.id);
        return [p.id, o ? [{ kind: "asset", assetId: o.assetId }] : []];
      }),
    );
  },

  blocker(node, inputs, ctx) {
    const key = layersModelKeyOf(node.params.model, ctx);
    const stop = modelBlocker(key, ctx);
    if (stop) return stop;
    const model = ctx.model(key)!;
    const rules = model.capabilities.layers;
    if (!layerCapable(model) || !rules) return { kind: "model_unavailable", model: model.key };
    const images = imagesOf(inputs, "image");
    const count = imageCount(images);
    if (count === 0) return { kind: "missing_input", port: "image" };
    // One stack per node: its outputs are that stack's layers.
    if (count > 1) return { kind: "layer_input", problem: "several" };
    const [only] = imagesNow(images);
    const size = only ? ctx.imageSize?.(only) : undefined;
    if (size && size.width * size.height < rules.minPixels) {
      const side = Math.ceil(Math.sqrt(rules.minPixels));
      return { kind: "layer_input", problem: "small", width: side, height: side };
    }
    return null;
  },

  compile(node, inputs, ctx, fingerprint) {
    const key = layersModelKeyOf(node.params.model, ctx)!;
    const model = ctx.model(key)!;
    const size = layerSizeOf(model, node.params.size);
    const base = imagesOf(inputs, "image");
    const prompt = node.params.prompt.trim();
    // As POST /api/layers sends it (layersRequest): one call, the image's own shape.
    const call: RunCall = {
      model: key,
      op: "decompose",
      prompt,
      size: { kind: "auto" },
      batch: 1,
      seed: null,
      layers: { size },
    };
    const lone = base.length === 1 && base[0]!.kind === "asset" ? base[0]!.assetId : null;
    const known = lone ? ctx.imageSize?.(lone) : undefined;
    const cost = estimate(model, {
      batch: 1,
      op: "decompose",
      prompt,
      base: { assetId: lone ?? node.id, role: "base" },
      layers: { size },
      ...(known && { inputImageSizes: [known] }),
      speed: speedOf(ctx, model, "decompose"),
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
          inputs: base.length
            ? [{ port: "image", to: "base", arity: "single", values: base.map(planValue) }]
            : [],
          calls: [call],
          cached: null,
        },
        expectedJobs: 1,
        estimate: cost,
        fanOut: 1,
      },
    };
  },
};

const readLayerSize = (value: unknown): LayerSize | undefined =>
  typeof value === "string" && (LAYER_SIZES as readonly string[]).includes(value)
    ? (value as LayerSize)
    : undefined;

export const layersSpec: NodeSpec<LayersParams> = {
  type: "image.layers",
  typeVersion: 1,
  label: "canvas.nodes.layers.label",
  description: "canvas.nodes.layers.description",
  keywords: ["layers", "split", "separate", "decompose", "cut out", "psd", "background"],
  category: "edit",
  menu: { group: "image", order: 3 },
  // Some model has to split images.
  listed: (ctx) => ctx.models.some(layerCapable),
  size: { w: LAYERS_WIDTH, h: layersHeight(0) },
  resizable: false,
  // Its height follows its rows: one per layer it made, or the hint before it has any.
  box: (input) => layersBox(input),
  imageBox: (input) => layersBox(input),
  annotation: false,
  ports: LAYERS_PORTS,
  portsOf: (node) => [LAYERS_INPUT, ...layerRows(node)],
  defaults: (ctx) => {
    const model = layersModelKeyOf(undefined, ctx);
    return { ...(model && { model }), prompt: "" };
  },
  parseParams: (raw) => ({
    model: readModel(raw.model),
    prompt: readString(raw, "prompt"),
    size: readLayerSize(raw.size),
  }),
  runnable: true,
  engine: layersEngine,
};

const NO_LINKS: ReadonlySet<string> = new Set();

function layersBox({ result, linked }: NodeBoxInput): Size {
  return {
    w: LAYERS_WIDTH,
    h: layersHeight(layerRows({ result, linked: linked ?? (() => NO_LINKS) }).length),
  };
}
