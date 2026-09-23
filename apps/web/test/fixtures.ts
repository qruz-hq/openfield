import type {
  AssetListItem,
  Capabilities,
  Job,
  JobSet,
  JobSetWithJobs,
  ModelListItem,
} from "@openfield/core";

// Small, hand-written manifests: one aspect-and-tier model, one with quality levels.

const base: Capabilities = {
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
  size: { mode: "aspect", ratios: ["auto", "1:1", "3:4", "4:3", "4:5", "16:9"], default: "auto" },
  resolution: { tiers: ["1K", "2K", "4K"], default: "1K" },
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
  unsupported: { seed: { reason: "Banana doesn't support seeds." } },
  unsupportedParamPolicy: "drop-with-warning",
};

export const banana: ModelListItem = {
  key: "google:banana",
  providerId: "google",
  modelId: "banana",
  displayName: "Banana",
  capabilities: base,
  price: {
    kind: "per_image",
    currency: "USD",
    pricedAt: "2026-09-23",
    sourceUrl: "https://example.com/prices",
    tiers: [
      { tier: "1K", usd: 0.134 },
      { tier: "2K", usd: 0.134 },
      { tier: "4K", usd: 0.24 },
    ],
  },
  source: "static",
  manifestVersion: "1",
  fetchedAt: "2026-09-23",
  ready: true,
  enabled: true,
};

export const flare: ModelListItem = {
  ...banana,
  key: "openai:flare",
  providerId: "openai",
  modelId: "flare",
  displayName: "Flare",
  capabilities: {
    ...base,
    size: { mode: "aspect", ratios: ["1:1", "2:3", "3:2"], default: "1:1" },
    resolution: { tiers: ["1K", "1.5K"], default: "1K" },
    quality: {
      levels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
      default: "medium",
    },
    batch: { max: 4, native: true },
    emulated: [],
  },
  price: { kind: "unknown" },
  ready: false,
};

export const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 12, minute)).toISOString();

let n = 0;
const ulid = () => `01K6BQ8000000000000000${String(n++).padStart(4, "0")}`;

export function jobSet(
  createdAt: string,
  statuses: Job["status"][],
  extra: Partial<JobSet> = {},
): JobSetWithJobs {
  const id = ulid();
  return {
    jobSet: {
      id,
      status: "running",
      op: "generate",
      model: "google:banana",
      batchSize: statuses.length,
      prompt: "a teapot",
      promptOriginal: null,
      source: "composer",
      priority: 10,
      costEstimateUsd: null,
      costActualUsd: null,
      errorCode: null,
      errorMessage: null,
      canvasId: null,
      canvasNodeId: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      ...extra,
    },
    jobs: statuses.map((status, idx) => ({
      id: ulid(),
      jobSetId: id,
      idx,
      status,
      width: 1536,
      height: 2048,
      progress: null,
      seed: null,
      attempt: 0,
      assetId: null,
      errorCode: status === "failed" ? "network" : null,
      errorMessage: null,
      errorReason: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    })),
  };
}

export function asset(createdAt: string, extra: Partial<AssetListItem> = {}): AssetListItem {
  const id = ulid();
  return {
    id,
    kind: "generated",
    jobSetId: null,
    jobId: null,
    width: 1536,
    height: 2048,
    mime: "image/png",
    sha256: "0".repeat(64),
    providerId: "google",
    modelId: "banana",
    prompt: "a teapot",
    approximate: false,
    isFavourite: false,
    createdAt,
    thumbUrl: `/files/thumb/${id}?h=456`,
    fileUrl: `/files/asset/${id}`,
    ...extra,
  };
}
