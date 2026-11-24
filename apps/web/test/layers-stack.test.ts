// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { Asset, AssetDetailResponse, LayerBox, LayerStackResponse, StackLayer } from "@openfield/core";
import {
  boxPercent,
  layerInputProblem,
  layerOf,
  layerPosition,
  moveLayer,
  pricingOf,
  rowsTopFirst,
  stackCost,
  stackEntries,
  stackRunOf,
} from "../src/detail/layers/stack";
import { asset, at, banana } from "./fixtures";

// The Layers tab's stack: the server lists it base first then bottom up; the tab lists it top
// first with the base pinned at the bottom; Flatten and the downloads send the visible entries
// bottom first again.

const CANVAS = { width: 1152, height: 1536 };

function full(extra: Partial<Asset> = {}): Asset {
  const item = asset(at(10));
  return {
    ...item,
    bytes: 1000,
    seed: null,
    params: null,
    tags: "",
    costUsd: 0.0225,
    parentAssetId: null,
    rootAssetId: item.id,
    op: "decompose",
    opParams: null,
    maskAssetId: null,
    generative: true,
    approximateReason: null,
    fileState: "ok",
    updatedAt: item.createdAt,
    deletedAt: null,
    ...extra,
  };
}

function entry(role: "base" | "layer", zIndex: number, name: string | null, box?: LayerBox): StackLayer {
  const layer = { role, zIndex, canvas: CANVAS, ...(box && { box }), ...(name && { name }) };
  return {
    asset: full({ jobSetId: "01RUN0000000000000000000000", opParams: { layer } }),
    role,
    zIndex,
    box: box ?? [0, 0, CANVAS.width, CANVAS.height],
    name,
    description: null,
    text: null,
  };
}

const base = entry("base", 0, null);
const cloth = entry("layer", 1, "Cream cloth", [0, 900, 1152, 1536]);
const small = entry("layer", 2, "Small white vase", [600, 1000, 950, 1500]);
const tall = entry("layer", 3, "Tall white vase", [276, 772, 556, 1462]);
const berries = entry("layer", 4, "Red berries", [200, 300, 800, 900]);
// As the server sends it: the base first, then the layers from the bottom up.
const stack: LayerStackResponse = {
  runId: "01RUN0000000000000000000000",
  source: null,
  canvas: CANVAS,
  layers: [base, cloth, small, tall, berries],
};
const ids = (rows: readonly StackLayer[]) => rows.map((r) => r.name ?? "Base");

describe("stack order", () => {
  test("lists the layers top first, with the base pinned at the bottom", () => {
    expect(ids(rowsTopFirst(stack))).toEqual([
      "Red berries",
      "Tall white vase",
      "Small white vase",
      "Cream cloth",
      "Base",
    ]);
  });

  test("follows a reordering, and keeps a layer it doesn't name in the model's place above", () => {
    const order = [cloth.asset.id, berries.asset.id, tall.asset.id];
    expect(ids(rowsTopFirst(stack, order))).toEqual([
      "Small white vase",
      "Cream cloth",
      "Red berries",
      "Tall white vase",
      "Base",
    ]);
  });

  test("moves a layer among the layers, never past the base", () => {
    const rows = rowsTopFirst(stack);
    const moved = moveLayer(rows, berries.asset.id, 99);
    expect(moved).toEqual([tall.asset.id, small.asset.id, cloth.asset.id, berries.asset.id]);
    expect(moved).not.toContain(base.asset.id);
    expect(moveLayer(rows, base.asset.id, 0)).toEqual(rows.slice(0, 4).map((r) => r.asset.id));
    expect(ids(rowsTopFirst(stack, moveLayer(rows, cloth.asset.id, 0)))[0]).toBe("Cream cloth");
  });

  test("counts a layer's place from the top, as the list shows it", () => {
    expect(layerPosition(stack, tall.asset.id)).toEqual({ index: 2, count: 4 });
    expect(layerPosition(stack, base.asset.id)).toBeNull();
  });
});

describe("flatten and export payload", () => {
  test("sends every entry bottom first, the base first of all", () => {
    expect(stackEntries(rowsTopFirst(stack), new Set())).toEqual([
      { assetId: base.asset.id },
      { assetId: cloth.asset.id },
      { assetId: small.asset.id },
      { assetId: tall.asset.id },
      { assetId: berries.asset.id },
    ]);
  });

  test("leaves hidden layers out and follows the order on screen", () => {
    const rows = rowsTopFirst(stack, [cloth.asset.id, berries.asset.id, tall.asset.id, small.asset.id]);
    const hidden = new Set([tall.asset.id, base.asset.id]);
    expect(stackEntries(rows, hidden)).toEqual([
      { assetId: small.asset.id },
      { assetId: berries.asset.id },
      { assetId: cloth.asset.id },
    ]);
  });

  test("is empty when everything is hidden", () => {
    const rows = rowsTopFirst(stack);
    expect(stackEntries(rows, new Set(rows.map((r) => r.asset.id)))).toEqual([]);
  });
});

describe("which stack an image shows", () => {
  const source = full({ op: "generate" });
  const detail = (asset: Asset, children: Asset[] = []): AssetDetailResponse => ({
    asset,
    jobSet: null,
    params: null,
    references: [],
    lineage: { ancestors: [], children },
    mask: null,
    folders: [],
    isFavourite: false,
  });

  test("an image that was split shows its newest split", () => {
    const older = full({
      jobSetId: "OLDER-run",
      createdAt: at(11),
      opParams: { layer: { role: "base", zIndex: 0, canvas: CANVAS } },
    });
    const newer = full({
      jobSetId: "NEWER-run",
      createdAt: at(20),
      opParams: { layer: { role: "base", zIndex: 0, canvas: CANVAS } },
    });
    const edit = full({ jobSetId: "EDIT-run", createdAt: at(30) });
    expect(stackRunOf(detail(source, [older, newer, edit]))).toBe(newer.jobSetId);
    expect(stackRunOf(detail(source, [edit]))).toBeNull();
  });

  test("a split's base and its layers show their own run", () => {
    expect(stackRunOf(detail(tall.asset))).toBe(stack.runId);
    expect(layerOf(tall.asset)?.role).toBe("layer");
    expect(layerOf(source)).toBeNull();
  });
});

describe("drawing and pricing", () => {
  test("places a box as percentages of the canvas", () => {
    expect(boxPercent([288, 384, 576, 1152], CANVAS)).toEqual({ left: 25, top: 25, width: 25, height: 50 });
  });

  test("adds the run's cost from its images", () => {
    expect(stackCost(stack)).toBeCloseTo(0.1125, 6);
  });

  test("says why an image can't be split: its type, or too few pixels", () => {
    const model = {
      ...banana,
      capabilities: {
        ...banana.capabilities,
        layers: {
          sizes: ["auto", "1K"] as ("auto" | "1K")[],
          default: "auto" as const,
          mimeTypes: ["image/png", "image/jpeg"],
          maxBytes: 10_000_000,
          minPixels: 262_144,
          maxPixels: 36_000_000,
          maxRatio: 16,
          maxLayers: 16,
        },
      },
    };
    expect(layerInputProblem({ mime: "image/png", width: 1152, height: 1536 }, model)).toBeNull();
    expect(layerInputProblem({ mime: "image/png", width: 400, height: 600 }, model)).toEqual({
      kind: "small",
      width: 512,
      height: 512,
    });
    expect(layerInputProblem({ mime: "image/webp", width: 1152, height: 1536 }, model)).toEqual({
      kind: "type",
    });
  });
});

describe("the price box", () => {
  const layers = {
    sizes: ["auto", "1K", "1.5K", "2K"] as ("auto" | "1K" | "1.5K" | "2K")[],
    default: "auto" as const,
    mimeTypes: ["image/png", "image/jpeg"],
    maxBytes: 30_000_000,
    minPixels: 262_144,
    maxPixels: 36_000_000,
    maxRatio: 16,
  };
  const rates = [
    { tier: "1K" as const, usd: 0.02 },
    { tier: "1.5K" as const, usd: 0.02 },
    { tier: "2K" as const, usd: 0.035 },
  ];
  const byPixels = [{ maxPixels: 2_601_123, usd: 0.02 }, { usd: 0.035 }];
  // Seedream 5.5's shape: $0.008 for the image sent in, and a number of layers to choose.
  const v55 = {
    ...banana,
    capabilities: {
      ...banana.capabilities,
      ops: { ...banana.capabilities.ops, decomposeLayers: true },
      layers: { ...layers, maxLayers: 99, choose: { min: 1, default: 16 }, text: true },
    },
    price: {
      kind: "per_image" as const,
      currency: "USD",
      pricedAt: "2026-11-17",
      sourceUrl: "https://docs.byteplus.com/en/docs/ModelArk/1099320",
      tiers: rates,
      byPixels,
      inputImage: { usd: 0.008, freePerCall: 0 },
      decompose: { tiers: rates, byPixels, outputs: { min: 2, max: 100 } },
    },
  };
  const image = { id: "01IMAGE000000000000000000AA", width: 1024, height: 1024 };

  test("rates leave out the image sent in, which has a row of its own", () => {
    const pricing = pricingOf(v55, image, "auto")!;
    expect(pricing.rate).toBe("$0.02");
    expect(pricing.input).toBe("$0.008");
    expect(pricing.most).toBe(16);
    expect([pricing.estimate.min, pricing.estimate.max]).toEqual([0.048, 0.348]);
  });

  test("the most follows the number asked for, held to the model's range", () => {
    expect(pricingOf(v55, image, "auto", 40)!.most).toBe(40);
    expect(pricingOf(v55, image, "auto", 40)!.estimate.max).toBe(0.828);
    expect(pricingOf(v55, image, "auto", 500)!.most).toBe(99);
    expect(pricingOf(v55, image, "2K", 1)!.estimate.max).toBe(0.078);
  });

  test("a model that picks for itself keeps its own most, and no input row when inputs are free", () => {
    const fixed = {
      ...v55,
      capabilities: { ...v55.capabilities, layers: { ...layers, maxLayers: 16 } },
      price: {
        ...v55.price,
        inputImage: { usd: 0.003, freePerCall: 1 },
        decompose: { ...v55.price.decompose, outputs: { min: 2, max: 17 } },
      },
    };
    const pricing = pricingOf(fixed, image, "auto", 40)!;
    expect(pricing.most).toBe(16);
    expect(pricing.input).toBeNull();
    expect(pricing.rate).toBe("$0.02");
  });
});
