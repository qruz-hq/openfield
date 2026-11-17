import {
  type Asset,
  type AssetDetailResponse,
  type AssetListItem,
  type CostEstimate,
  DEFAULT_CURRENCY,
  formatLocale,
  formatPrice,
  type LayerBox,
  type LayerOpParams,
  type LayerSize,
  type LayerStackResponse,
  layerOpParamsSchema,
  type ModelListItem,
  type StackEntry,
  type StackLayer,
  t,
} from "@openfield/core";
import { chosenLayers, estimate, layerOutputs, priceFor } from "@openfield/providers/manifest";

// A layer stack as the Layers tab shows it, and what it sends back. The server lists a stack bottom
// up with the base first; the tab lists it top first with the base pinned at the bottom, the way
// layers read in an image editor. Flatten and export take the visible entries bottom first again.

/** What an image made by a split records about its place in the stack, or null for any other image. */
export function layerOf(asset: Pick<Asset, "opParams"> | null | undefined): LayerOpParams | null {
  const parsed = layerOpParamsSchema.safeParse(asset?.opParams?.layer);
  return parsed.success ? parsed.data : null;
}

/**
 * The run whose stack this image's Layers tab shows: its own when it's a split's base or layer, else
 * the newest split made from it (its children carry the base). Null when it was never split.
 */
export function stackRunOf(detail: Pick<AssetDetailResponse, "asset" | "lineage">): string | null {
  if (layerOf(detail.asset)) return detail.asset.jobSetId;
  const bases = detail.lineage.children.filter((child) => layerOf(child)?.role === "base");
  const newest = bases.reduce<Asset | null>(
    (best, b) => (!best || b.createdAt > best.createdAt ? b : best),
    null,
  );
  return newest?.jobSetId ?? null;
}

/** The stack's layers top first, in `order` where it names them (ids, top first), then the base. */
export function rowsTopFirst(
  stack: Pick<LayerStackResponse, "layers">,
  order: readonly string[] = [],
): StackLayer[] {
  const layers = stack.layers.filter((l) => l.role === "layer");
  const base = stack.layers.filter((l) => l.role === "base");
  const rank = new Map(order.map((id, i) => [id, i]));
  // Layers the order doesn't name yet (a stack read again) keep the model's own place, above the rest.
  const sorted = [...layers].sort((a, b) => {
    const ra = rank.get(a.asset.id);
    const rb = rank.get(b.asset.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return 1;
    if (rb !== undefined) return -1;
    return b.zIndex - a.zIndex;
  });
  return [...sorted, ...base];
}

/** The ids of `rows` with `id` moved to `to` among the layers. The base never moves. */
export function moveLayer(rows: readonly StackLayer[], id: string, to: number): string[] {
  const ids = rows.filter((r) => r.role === "layer").map((r) => r.asset.id);
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const target = Math.max(0, Math.min(ids.length - 1, to));
  ids.splice(from, 1);
  ids.splice(target, 0, id);
  return ids;
}

/**
 * What Flatten and the downloads send: the visible entries, bottom first. Hidden ones are left out,
 * so a download holds only what's on screen.
 */
export function stackEntries(rows: readonly StackLayer[], hidden: ReadonlySet<string>): StackEntry[] {
  return [...rows]
    .reverse()
    .filter((r) => !hidden.has(r.asset.id))
    .map((r) => ({ assetId: r.asset.id }));
}

/** A layer's place as the list shows it: "Layer 2 of 4", counted from the top, base aside. */
export function layerPosition(
  stack: Pick<LayerStackResponse, "layers">,
  assetId: string,
): { index: number; count: number } | null {
  const layers = rowsTopFirst(stack).filter((r) => r.role === "layer");
  const index = layers.findIndex((r) => r.asset.id === assetId);
  return index < 0 ? null : { index: index + 1, count: layers.length };
}

/** A box on the stack's canvas, as percentages of it, for drawing over the image at any zoom. */
export function boxPercent(box: LayerBox, canvas: { width: number; height: number }) {
  const [left, top, right, bottom] = box;
  return {
    left: (left / canvas.width) * 100,
    top: (top / canvas.height) * 100,
    width: ((right - left) / canvas.width) * 100,
    height: ((bottom - top) / canvas.height) * 100,
  };
}

/** Models that split images into layers, ready ones first. */
export const layerModels = (models: readonly ModelListItem[]): ModelListItem[] =>
  models
    .filter((m) => m.enabled && m.capabilities.ops.decomposeLayers && m.capabilities.layers)
    .sort((a, b) => Number(b.ready) - Number(a.ready));

export type LayerInputProblem = { kind: "small"; width: number; height: number } | { kind: "type" } | null;

/** Why the model can't split this image: too few pixels, or a file type it doesn't take. */
export function layerInputProblem(
  image: { mime: string; width: number; height: number },
  model: Pick<ModelListItem, "capabilities"> | undefined,
): LayerInputProblem {
  const rules = model?.capabilities.layers;
  if (!rules) return null;
  if (!rules.mimeTypes.includes(image.mime)) return { kind: "type" };
  if (image.width * image.height < rules.minPixels) {
    const side = Math.ceil(Math.sqrt(rules.minPixels));
    return { kind: "small", width: side, height: side };
  }
  return null;
}

/** What the run cost, from its images' own costs; null when none says. */
export function stackCost(stack: Pick<LayerStackResponse, "layers">): number | null {
  const costs = stack.layers.flatMap((l) => (l.asset.costUsd === null ? [] : [l.asset.costUsd]));
  return costs.length ? costs.reduce((sum, c) => sum + c, 0) : null;
}

/** "$0.0225": a per-image rate to the hundredth of a cent, as the price box and a layer's Cost read. */
export const formatRate = (amount: number, currency: string = DEFAULT_CURRENCY) =>
  new Intl.NumberFormat(formatLocale(), {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);

export interface Pricing {
  estimate: CostEstimate;
  /** One image's rate, the base's and each layer's. */
  rate: string;
  /** What the image sent in costs, on models that charge for it. */
  input: string | null;
  /** The most layers, besides the base. */
  most: number;
  atMost: string;
}

/**
 * What a split of this image costs: the range for the button, the rates for the price box. An
 * image whose size isn't known yet (a canvas input still to be made) is priced over every rate.
 * `maxLayers` is the most asked for, on models that take a number.
 */
export function pricingOf(
  model: ModelListItem,
  image: Pick<AssetListItem, "id"> & Partial<Pick<AssetListItem, "width" | "height">>,
  size: LayerSize,
  maxLayers?: number,
): Pricing | null {
  const price = priceFor(model, "standard");
  if (price.kind !== "per_image" || !price.decompose) return null;
  const most = chosenLayers(model.capabilities.layers, maxLayers);
  const layers = { size, ...(most !== undefined && { maxLayers: most }) };
  const outputs = layerOutputs(model, price, { layers });
  const cost = estimate(model, {
    batch: 1,
    op: "decompose",
    base: { assetId: image.id, role: "base" },
    layers,
    ...(image.width && image.height && { inputImageSizes: [{ width: image.width, height: image.height }] }),
    speed: "standard",
  });
  if (cost.confidence === "unknown") return null;
  // The one image sent in is in the estimate; the rates are for what comes out.
  const rule = price.inputImage;
  const input = rule && "usd" in rule ? Math.max(0, 1 - rule.freePerCall) * rule.usd : 0;
  const low = (cost.min - input) / outputs.min;
  const high = (cost.max - input) / outputs.max;
  const rate =
    formatRate(low, cost.currency) === formatRate(high, cost.currency)
      ? formatRate(low, cost.currency)
      : t("cost.range", { min: formatRate(low, cost.currency), max: formatRate(high, cost.currency) });
  return {
    estimate: cost,
    rate,
    input: input > 0 ? formatRate(input, cost.currency) : null,
    most: outputs.max - 1,
    atMost: t("layers.price.atMost", { cost: formatPrice(cost.max, cost.currency) }),
  };
}
