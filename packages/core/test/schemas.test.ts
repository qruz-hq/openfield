// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import { SETTINGS_DEFAULTS, SSE_EVENT_TYPES } from "../src";
import {
  CANVAS_SCHEMA,
  CanvasVersionError,
  canvasDocumentSchema,
  migrateCanvasDocument,
} from "../src/canvas";
import {
  assetBulkBodySchema,
  assetsListQuerySchema,
  capabilitiesSchema,
  editBodySchema,
  errorEnvelopeSchema,
  type GenerateRequest,
  generateBodySchema,
  generateRequestSchema,
  jobSetAcceptedSchema,
  modelListItemSchema,
  modelManifestSchema,
  normalizedRequestSchema,
  parseSseFrame,
  presetBundleSchema,
  presetEnvelopeSchema,
  presetObjectSchema,
  priceModelSchema,
  settingsPatchSchema,
  settingsSchema,
  sseEventSchema,
} from "../src/schemas";
import { ID_A, ID_B, ID_C, NOW, sampleManifest } from "./fixtures";

const roundTrip = <T>(schema: { parse(v: unknown): T }, value: unknown): T =>
  schema.parse(JSON.parse(JSON.stringify(schema.parse(value))));

describe("manifest", () => {
  test("round-trips a full manifest", () => {
    expect(roundTrip(modelManifestSchema, sampleManifest)).toEqual(sampleManifest);
  });

  test("rejects unknown fields anywhere", () => {
    expect(modelManifestSchema.safeParse({ ...sampleManifest, extra: 1 }).success).toBe(false);
    const caps = { ...sampleManifest.capabilities, batch: { max: 4, native: false, maxImagesPerRequest: 4 } };
    expect(capabilitiesSchema.safeParse(caps).success).toBe(false);
  });

  test("checks defaults against their own option lists", () => {
    const caps = sampleManifest.capabilities;
    expect(
      capabilitiesSchema.safeParse({ ...caps, resolution: { tiers: ["1K"], default: "4K" } }).success,
    ).toBe(false);
    expect(
      capabilitiesSchema.safeParse({ ...caps, size: { mode: "aspect", ratios: ["1:1"], default: "3:4" } })
        .success,
    ).toBe(false);
    expect(
      capabilitiesSchema.safeParse({
        ...caps,
        quality: { levels: [{ id: "low", label: "Low" }], default: "high" },
      }).success,
    ).toBe(false);
  });

  test("holds batch to four and a key to its parts", () => {
    const caps = sampleManifest.capabilities;
    expect(capabilitiesSchema.safeParse({ ...caps, batch: { max: 8, native: true } }).success).toBe(false);
    expect(modelManifestSchema.safeParse({ ...sampleManifest, key: "google:other" }).success).toBe(false);
  });

  test("list items add what the picker needs", () => {
    const item = modelListItemSchema.parse({ ...sampleManifest, ready: true, enabled: true });
    expect(item.ready).toBe(true);
  });

  test("price models", () => {
    expect(priceModelSchema.parse({ kind: "unknown" })).toEqual({ kind: "unknown" });
    expect(
      priceModelSchema.safeParse({
        kind: "per_token",
        currency: "USD",
        textInputPerMTok: 5,
        imageInputPerMTok: 8,
        imageOutputPerMTok: 30,
        outputTokenTable: [{ quality: "high", size: "1024x1024", tokens: 4160 }],
        pricedAt: "2026-09-23",
        sourceUrl: "https://openai.com/api/pricing",
      }).success,
    ).toBe(true);
  });
});

const request: GenerateRequest = {
  idempotencyKey: ID_A,
  model: "google:gemini-3-pro-image",
  op: "generate",
  prompt: "A ceramic teapot on linen, soft window light",
  size: { kind: "aspect", ratio: "3:4" },
  resolution: "2K",
  batch: 2,
  seed: null,
  references: [{ assetId: ID_B, role: "style", weight: 0.7 }],
  source: "composer",
};

describe("requests", () => {
  test("GenerateRequest round-trips", () => {
    expect(roundTrip(generateRequestSchema, request)).toEqual(request);
  });

  test("each route takes only its own ops", () => {
    expect(generateBodySchema.safeParse(request).success).toBe(true);
    expect(generateBodySchema.safeParse({ ...request, op: "edit" }).success).toBe(false);
    expect(editBodySchema.safeParse(request).success).toBe(false);
    expect(
      editBodySchema.safeParse({ ...request, op: "inpaint", base: { assetId: ID_C, role: "base" } }).success,
    ).toBe(true);
  });

  test("rejects a slash model key and a batch over four", () => {
    expect(generateRequestSchema.safeParse({ ...request, model: "google/gemini-3-pro-image" }).success).toBe(
      false,
    );
    expect(generateRequestSchema.safeParse({ ...request, batch: 5 }).success).toBe(false);
  });

  test("NormalizedRequest drops library ids and carries the frozen fields", () => {
    const normalized = normalizedRequestSchema.parse({
      ...request,
      seed: undefined,
      presetId: "of_preset_35mm_grain",
      jobId: ID_B,
      jobSetId: ID_C,
      batchIndex: 0,
      batch: 1,
      size: { width: 1536, height: 2048 },
      promptAfterPreset: request.prompt,
      manifestVersion: "1",
      paramsHash: `sha256:${"a".repeat(64)}`,
    });
    expect("presetId" in normalized).toBe(false);
    expect(normalized.size).toEqual({ width: 1536, height: 2048 });
    expect(normalizedRequestSchema.safeParse({ ...normalized, paramsHash: "abc" }).success).toBe(false);
  });
});

describe("settings", () => {
  test("an empty object yields every default", () => {
    const settings = settingsSchema.parse({});
    expect(settings).toEqual(SETTINGS_DEFAULTS);
    expect(settings.theme).toBe("system");
    expect(settings.trashRetentionDays).toBeNull();
    expect(settings.globalConcurrency).toBe(4);
  });

  test("covers every §6.17 key", () => {
    expect(Object.keys(settingsSchema.shape).sort()).toEqual(
      [
        "modelRefreshedAt",
        "modelRefreshHours",
        "defaultModel",
        "defaultAspect",
        "defaultBatch",
        "globalConcurrency",
        "enhanceMode",
        "enhancerModel",
        "regionalFallback",
        "theme",
        "feedZoom",
        "tipsCard",
        "thumbQuality",
        "trashRetentionDays",
        "spendGuardUsd",
        "logLevel",
        "showExperimental",
        "canvasFileWriteThrough",
        "upscaleCommandPath",
      ].sort(),
    );
  });

  test("patches change only what they name and reject unknown keys", () => {
    expect(settingsPatchSchema.parse({ theme: "light" })).toEqual({ theme: "light" });
    expect(settingsPatchSchema.parse({ trashRetentionDays: 30 })).toEqual({ trashRetentionDays: 30 });
    expect(settingsPatchSchema.safeParse({ theme: "sepia" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ colour: "red" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ trashRetentionDays: 0 }).success).toBe(false);
  });

  test("the upscale program can't be set through PATCH", () => {
    expect(settingsPatchSchema.safeParse({ upscaleCommandPath: "/bin/sh -c id" }).success).toBe(false);
  });

  test("stored keys we no longer know are dropped", () => {
    expect(settingsSchema.parse({ oldKey: 1, feedZoom: 1 }).feedZoom).toBe(1);
    expect("oldKey" in settingsSchema.parse({ oldKey: 1 })).toBe(false);
  });
});

const job = {
  id: ID_B,
  jobSetId: ID_A,
  idx: 0,
  status: "pending",
  width: 1536,
  height: 2048,
  progress: null,
  seed: null,
  attempt: 0,
  assetId: null,
  errorCode: null,
  errorMessage: null,
  errorReason: null,
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
};
const jobSet = {
  id: ID_A,
  status: "pending",
  op: "generate",
  model: "google:gemini-3-pro-image",
  batchSize: 1,
  prompt: "a teapot",
  promptOriginal: null,
  source: "composer",
  priority: 10,
  costEstimateUsd: 0.134,
  costActualUsd: null,
  errorCode: null,
  errorMessage: null,
  canvasId: null,
  canvasNodeId: null,
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
};
const assetItem = {
  id: ID_C,
  kind: "generated",
  jobSetId: ID_A,
  jobId: ID_B,
  width: 1536,
  height: 2048,
  mime: "image/png",
  sha256: "f".repeat(64),
  providerId: "google",
  modelId: "gemini-3-pro-image",
  prompt: "a teapot",
  approximate: false,
  isFavourite: false,
  createdAt: NOW,
  thumbUrl: `/files/thumb/${ID_C}?h=456`,
  fileUrl: `/files/asset/${ID_C}`,
};

describe("job sets and events", () => {
  test("the 202 body round-trips", () => {
    const accepted = { jobSet, jobs: [job] };
    expect(roundTrip(jobSetAcceptedSchema, accepted)).toEqual(accepted as never);
  });

  test("every event type has a schema", () => {
    const names = sseEventSchema.options.map((option) => option.shape.event.value);
    expect([...names].sort()).toEqual([...SSE_EVENT_TYPES].sort());
  });

  test("frames parse into typed events", () => {
    const output = parseSseFrame(
      "job.output",
      JSON.stringify({ jobSetId: ID_A, jobId: ID_B, idx: 0, asset: assetItem }),
    );
    expect(output?.event).toBe("job.output");
    if (output?.event === "job.output") expect(output.data.asset.width).toBe(1536);

    const failed = parseSseFrame(
      "job.failed",
      JSON.stringify({
        jobSetId: ID_A,
        jobId: ID_B,
        idx: 0,
        error: { code: "timeout", message: "", retryable: true },
      }),
    );
    expect(failed?.event).toBe("job.failed");

    const snapshot = parseSseFrame(
      "snapshot",
      JSON.stringify({ activeJobSets: [{ jobSet, jobs: [job] }], serverTime: NOW }),
    );
    expect(snapshot?.event).toBe("snapshot");
  });

  test("unknown or broken frames come back null", () => {
    expect(parseSseFrame("job.exploded", "{}")).toBeNull();
    expect(parseSseFrame("job.progress", "not json")).toBeNull();
    expect(parseSseFrame("job.progress", JSON.stringify({ jobId: ID_B, progress: 40 }))).toBeNull();
  });

  test("error envelope takes transport and provider codes, nothing else", () => {
    const envelope = { error: { code: "bad_request", message: "prompt: Required", retryable: false } };
    expect(roundTrip(errorEnvelopeSchema, envelope)).toEqual(envelope as never);
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: "rate_limited", message: "", retryable: true } })
        .success,
    ).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: "missing_credential", message: "", retryable: false } })
        .success,
    ).toBe(false);
  });
});

describe("assets", () => {
  test("list query reads strings the way a URL sends them", () => {
    expect(assetsListQuerySchema.parse({ limit: "50", favourite: "1" })).toEqual({
      limit: 50,
      favourite: true,
    });
    expect(assetsListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  test("folder actions need a folder", () => {
    expect(assetBulkBodySchema.safeParse({ ids: [ID_A], action: "addFolder" }).success).toBe(false);
    expect(assetBulkBodySchema.safeParse({ ids: [ID_A], action: "addFolder", folderId: ID_B }).success).toBe(
      true,
    );
    expect(assetBulkBodySchema.safeParse({ ids: [ID_A], action: "delete" }).success).toBe(true);
  });
});

const stylePreset = {
  schemaVersion: 1,
  id: "of_preset_35mm_grain",
  kind: "style",
  name: "35mm Grain",
  description: "Film look with visible grain and soft highlights.",
  template: "{prompt}, shot on 35mm colour film, fine visible grain",
  variants: { light: "{prompt}, subtle 35mm film grain" },
  negativePrompt: "oversharpened, plastic skin",
  strength: 1,
  references: [{ assetId: ID_A, weight: 0.7, role: "style" }],
  params: { aspectRatio: "3:2" },
  providerOverrides: { "openai:gpt-image-2.5-sunburst": { quality: "high" }, "google:*": {} },
  palette: { hex: ["#2B2A26", "#8A7B62"], mode: "prompt" },
  tags: ["film"],
  author: "",
  license: "CC0-1.0",
  source: "",
  createdAt: NOW,
  updatedAt: NOW,
};

describe("presets", () => {
  test("the §5.3 object round-trips", () => {
    expect(roundTrip(presetObjectSchema, stylePreset)).toEqual(stylePreset as never);
    expect(presetEnvelopeSchema.parse(stylePreset).kind).toBe("style");
  });

  test("the template needs {prompt} exactly once", () => {
    for (const template of ["no slot", "{prompt} and {prompt}"]) {
      const result = presetObjectSchema.safeParse({ ...stylePreset, template });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("Include {prompt} exactly once.");
    }
  });

  test("a newer file says so in plain words", () => {
    const result = presetEnvelopeSchema.safeParse({ ...stylePreset, schemaVersion: 2 });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((i) => i.message === "This style needs a newer version of Openfield."),
    ).toBe(true);
  });

  test("bundles route by kind and keep files inside the bundle", () => {
    const bundle = presetBundleSchema.parse({
      schemaVersion: 1,
      presets: [
        { ...stylePreset, references: [{ file: "refs/01.webp", role: "style" }] },
        { schemaVersion: 1, id: "muted_earth", kind: "palette", name: "Muted Earth", hex: ["#6B5B45"] },
        {
          schemaVersion: 1,
          id: "ana",
          kind: "character",
          name: "Ana",
          descriptor: "curly dark hair",
          token: "@ana",
        },
        { schemaVersion: 1, id: "moodboard", kind: "reference-set", name: "Mood", references: [] },
      ],
    });
    expect(bundle.presets.map((p) => p.kind)).toEqual(["style", "palette", "character", "reference-set"]);
    for (const file of ["../secret.png", "/etc/passwd", "C:/x.png"]) {
      const result = presetEnvelopeSchema.safeParse({
        ...stylePreset,
        references: [{ file, role: "style" }],
      });
      expect(result.success).toBe(false);
    }
  });

  test("unknown top-level keys are dropped", () => {
    const parsed = presetEnvelopeSchema.parse({ ...stylePreset, run: "rm -rf" });
    expect("run" in parsed).toBe(false);
  });
});

const canvasDoc = {
  schema: CANVAS_SCHEMA,
  id: ID_A,
  name: "Untitled",
  createdAt: NOW,
  updatedAt: NOW,
  viewport: { x: -320, y: -140, zoom: 0.75 },
  nodes: [
    {
      id: "n_prompt_1",
      type: "prompt",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      params: { text: "a teapot" },
    },
    {
      id: "n_gen_1",
      type: "image.generate",
      typeVersion: 1,
      position: { x: 480, y: 120 },
      size: { w: 300, h: 300 },
      parentId: null,
      collapsed: false,
      title: null,
      params: {
        model: "google:gemini-3-pro-image",
        prompt: "",
        size: { kind: "aspect", ratio: "3:4" },
        resolution: "2K",
        batch: 4,
        seed: { mode: "random" },
        enhancePrompt: false,
        providerOptions: {},
      },
      presetLocks: ["size"],
      result: {
        state: "done",
        assetIds: [ID_B, ID_C],
        jobSetId: ID_C,
        fingerprint: `sha256:${"9".repeat(64)}`,
        costUsd: 0.536,
        ranAt: NOW,
      },
    },
  ],
  edges: [
    {
      id: "e_1",
      source: "n_prompt_1",
      sourceHandle: "text",
      target: "n_gen_1",
      targetHandle: "prompt",
      order: 0,
      kind: "data",
    },
  ],
  comments: [],
  meta: { appVersion: "0.1.0", previewPath: `canvases/previews/${ID_A}.png` },
};

describe("canvas documents", () => {
  test("round-trip, with defaults filled in", () => {
    const doc = roundTrip(canvasDocumentSchema, canvasDoc);
    expect(doc.nodes[0]?.collapsed).toBe(false);
    expect(doc.nodes[0]?.params).toEqual({ text: "a teapot" });
    expect(doc.nodes[1]?.result?.assetIds).toHaveLength(2);
  });

  test("catch broken references and bad generator settings", () => {
    const dupe = { ...canvasDoc, nodes: [canvasDoc.nodes[0], canvasDoc.nodes[0], canvasDoc.nodes[1]] };
    expect(canvasDocumentSchema.safeParse(dupe).success).toBe(false);
    const dangling = { ...canvasDoc, edges: [{ ...canvasDoc.edges[0], target: "n_missing" }] };
    expect(canvasDocumentSchema.safeParse(dangling).success).toBe(false);
    const gen = canvasDoc.nodes[1]!;
    const tooMany = {
      ...canvasDoc,
      nodes: [canvasDoc.nodes[0], { ...gen, params: { ...gen.params, batch: 8 } }],
    };
    const result = canvasDocumentSchema.safeParse(tooMany);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["nodes", 1, "params", "batch"]);
  });

  test("frames nest, but never in a circle, and only frames hold nodes", () => {
    const frame = (id: string, parentId: string | null) => ({
      id,
      type: "frame",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      parentId,
    });
    const withNodes = (nodes: unknown[]) =>
      canvasDocumentSchema.safeParse({ ...canvasDoc, nodes, edges: [] });
    expect(withNodes([frame("fa", null), frame("fb", "fa")]).success).toBe(true);
    const self = withNodes([frame("fs", "fs")]);
    expect(self.error?.issues[0]).toMatchObject({
      path: ["nodes", 0, "parentId"],
      message: "These frames sit inside each other in a circle.",
    });
    expect(withNodes([frame("fa", "fb"), frame("fb", "fa")]).success).toBe(false);
    const inPrompt = withNodes([canvasDoc.nodes[0], { ...frame("fc", canvasDoc.nodes[0]!.id) }]);
    expect(inPrompt.error?.issues[0]?.message).toBe("This node sits inside something that isn't a frame.");
  });

  test("migrate current documents and refuse newer ones", () => {
    expect(migrateCanvasDocument(canvasDoc).id).toBe(ID_A);
    expect(() => migrateCanvasDocument({ ...canvasDoc, schema: "openfield.canvas/9" })).toThrow(
      CanvasVersionError,
    );
    expect(() => migrateCanvasDocument({ nodes: [] })).toThrow(CanvasVersionError);
  });
});
