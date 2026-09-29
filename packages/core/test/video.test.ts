// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  generateRequestSchema,
  hostAllowed,
  jobSetsListQuerySchema,
  type ModelManifest,
  modalityOf,
  modelManifestSchema,
  type PriceModel,
  sseEventSchema,
  type VideoCapability,
  videoRate,
  videoTokens,
} from "../src";
import { ID_A, ID_B, ID_C, NOW, sampleManifest } from "./fixtures";

// Video in the contracts: a model says what it makes, a video model says what only video has, and
// a price counts tokens from the output's pixels and seconds.

const video: VideoCapability = {
  resolutions: ["480p", "720p"],
  defaultResolution: "720p",
  durations: [4, 5, 6],
  defaultDuration: 5,
  fps: 24,
  sizes: [{ resolution: "720p", aspect: "16:9", width: 1280, height: 720 }],
  frames: { start: true, end: false, mimeTypes: ["image/png"], maxBytes: 1000 },
  autoAspect: "always",
  startFrameForcesAuto: false,
  audio: { supported: true, default: true },
  cameraFixed: false,
};

const price: PriceModel = {
  kind: "video_tokens",
  currency: "USD",
  pricedAt: "2026-09-29",
  sourceUrl: "https://example.com/prices",
  rates: [{ resolution: "1080p", perMTok: 3 }, { audio: true, perMTok: 2 }, { perMTok: 1 }],
};

const videoModel = (): ModelManifest => ({
  ...sampleManifest,
  key: "acme:clip",
  providerId: "acme",
  modelId: "clip",
  modality: "video",
  capabilities: { ...sampleManifest.capabilities, video },
  price,
});

describe("video contracts", () => {
  test("a video model parses; modality and the video block come together", () => {
    expect(modelManifestSchema.safeParse(videoModel()).error?.issues ?? []).toEqual([]);
    const { video: _, ...caps } = videoModel().capabilities;
    expect(modelManifestSchema.safeParse({ ...videoModel(), capabilities: caps }).success).toBe(false);
    expect(
      modelManifestSchema.safeParse({ ...sampleManifest, capabilities: videoModel().capabilities }).success,
    ).toBe(false);
    // A model that names no modality makes images.
    expect(modalityOf(sampleManifest)).toBe("image");
    expect(modalityOf(videoModel())).toBe("video");
  });

  test("the video block's defaults are its own options, and an end frame needs a start", () => {
    const bad = (patch: Partial<VideoCapability>) =>
      modelManifestSchema.safeParse({
        ...videoModel(),
        capabilities: { ...videoModel().capabilities, video: { ...video, ...patch } },
      }).success;
    expect(bad({ defaultResolution: "1080p" })).toBe(false);
    expect(bad({ defaultDuration: 9 })).toBe(false);
    expect(bad({ frames: { ...video.frames, start: false, end: true } })).toBe(false);
    expect(bad({ audio: { supported: false, default: true } })).toBe(false);
  });

  test("tokens and rates", () => {
    expect(videoTokens({ width: 1248, height: 704 }, 24, 5)).toBe(102_960);
    if (price.kind !== "video_tokens") throw new Error("price");
    expect(videoRate(price, "1080p", false)).toBe(3);
    expect(videoRate(price, "720p", true)).toBe(2);
    expect(videoRate(price, "720p", false)).toBe(1);
    expect(videoRate(price, "720p", undefined)).toBe(1);
  });

  test("a request's video settings, and lists that default to images", () => {
    const parsed = generateRequestSchema.safeParse({
      idempotencyKey: ID_A,
      model: "acme:clip",
      op: "generate",
      prompt: "",
      size: { kind: "auto" },
      batch: 1,
      source: "api",
      video: { seconds: 5, resolution: "720p", audio: false, startFrame: { assetId: ID_B } },
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(generateRequestSchema.safeParse({ ...parsed.data, video: { resolution: "8k" } }).success).toBe(
      false,
    );
    expect(jobSetsListQuerySchema.parse({}).modality).toBe("image");
  });

  test("job.output carries a video's fields; an old frame without modality still reads as an image", () => {
    const asset = {
      id: ID_C,
      kind: "generated",
      jobSetId: ID_A,
      jobId: ID_B,
      width: 1280,
      height: 720,
      mime: "video/mp4",
      sha256: "f".repeat(64),
      providerId: "acme",
      modelId: "clip",
      prompt: "",
      approximate: false,
      isFavourite: false,
      rerun: false,
      createdAt: NOW,
      thumbUrl: `/files/thumb/${ID_C}?h=456`,
      fileUrl: `/files/asset/${ID_C}`,
    };
    const frame = (extra: object) =>
      sseEventSchema.parse({
        event: "job.output",
        data: { jobSetId: ID_A, jobId: ID_B, idx: 0, asset: { ...asset, ...extra } },
      });
    const clip = frame({
      modality: "video",
      durationMs: 5000,
      hasAudio: true,
      posterUrl: `/files/poster/${ID_C}`,
    });
    expect(clip.event === "job.output" && clip.data.asset).toMatchObject({
      modality: "video",
      durationMs: 5000,
    });
    const old = frame({});
    expect(old.event === "job.output" && old.data.asset.modality).toBe("image");
  });

  test("a wildcard host is one label under its parent, nothing more", () => {
    const allowed = ["api.example.com", "*.store.example.com"];
    expect(hostAllowed("api.example.com", allowed)).toBe(true);
    expect(hostAllowed("API.Example.com", allowed)).toBe(true);
    expect(hostAllowed("bucket-1.store.example.com", allowed)).toBe(true);
    for (const host of [
      "store.example.com",
      "a.b.store.example.com",
      "evilstore.example.com",
      "bucket.store.example.com.evil.test",
      "example.com",
    ]) {
      expect(hostAllowed(host, allowed)).toBe(false);
    }
  });
});
