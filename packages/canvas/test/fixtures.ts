import type { Capabilities, ModelListItem } from "@openfield/core";
import type { CanvasEdge, CanvasNode } from "@openfield/core/canvas";
import type { EngineContext } from "../src/engine/types";
import { emptyDocument, fromDocument } from "../src/store/document";
import type { DocSlice } from "../src/store/ops";

// A small model and document builders for the package's own tests.

const capabilities: Capabilities = {
  ops: {
    textToImage: true,
    imageEdit: true,
    inpaint: false,
    outpaint: false,
    upscale: false,
    removeBackground: false,
    detectText: false,
    decomposeLayers: false,
  },
  references: {
    supported: true,
    max: 14,
    roles: ["subject"],
    mimeTypes: ["image/png"],
    maxBytes: 20_000_000,
    weights: false,
    strengthMode: "none",
  },
  size: { mode: "aspect", ratios: ["auto", "1:1", "3:4", "4:3", "16:9"], default: "auto" },
  resolution: { tiers: ["1K", "2K"], default: "1K" },
  batch: { max: 4, native: false },
  seed: { supported: false, echoed: false },
  negativePrompt: false,
  promptEnhance: "openfield",
  styleStrength: false,
  transparency: false,
  streaming: { partialImages: false, progressPercent: false },
  output: { formats: ["png"], default: "png" },
  identity: { nativeCharacterRefs: false, nativeStylePresets: false },
  limits: { requestTimeoutMs: 120_000, typicalLatencyMs: [3000, 9000], maxConcurrent: 4 },
  controlOrder: ["model", "aspect", "resolution", "batch", "seed", "promptEnhance"],
  emulated: ["batch"],
  unsupported: {},
  unsupportedParamPolicy: "drop-with-warning",
};

export const banana: ModelListItem = {
  key: "google:banana",
  providerId: "google",
  modelId: "banana",
  displayName: "Banana",
  capabilities,
  price: {
    kind: "per_image",
    currency: "USD",
    pricedAt: "2026-09-23",
    sourceUrl: "https://example.com/prices",
    tiers: [
      { tier: "1K", usd: 0.04 },
      { tier: "2K", usd: 0.08 },
    ],
  },
  source: "static",
  manifestVersion: "1",
  fetchedAt: "2026-09-23",
  ready: true,
  enabled: true,
};

export const ctx: EngineContext = {
  models: [banana],
  model: (key) => (key === banana.key ? banana : undefined),
  defaultModel: banana.key,
  defaultBatch: 1,
};

export const CANVAS_ID = "01K6BQ8000000000000000CNVS";

export const node = (id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type,
  typeVersion: 1,
  position: { x: 0, y: 0 },
  parentId: null,
  collapsed: false,
  title: null,
  params: {},
  presetLocks: [],
  result: null,
  ...extra,
});

export const edge = (
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): CanvasEdge => ({ id, source, sourceHandle, target, targetHandle, kind: "data" });

export function docOf(nodes: CanvasNode[], edges: CanvasEdge[] = []): DocSlice {
  return fromDocument({ ...emptyDocument(CANVAS_ID, "Test"), nodes, edges }).slice;
}

/** Ids that count up, so tests can name what a batch makes. */
export function counters() {
  let n = 0;
  let e = 0;
  return { newNodeId: () => `n_${++n}`, newEdgeId: () => `e_${++e}` };
}
