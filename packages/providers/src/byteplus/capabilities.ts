import type {
  AspectRatio,
  Capabilities,
  ControlId,
  PriceModel,
  VideoCapability,
  VideoResolution,
} from "@openfield/core";
import { t } from "@openfield/core";

// Checked against BytePlus ModelArk's API reference (docs.byteplus.com/en/docs/ModelArk/1520757
// and /1521309) on 2026-09-29. Nothing here has run live yet: see README.md.

/** meta.displayName, and the company name in our copy. */
export const COMPANY = "BytePlus";
export const API_HOST = "ark.ap-southeast.bytepluses.com";
export const API_BASE = `https://${API_HOST}/api/v3`;
export const TASKS_URL = `${API_BASE}/contents/generations/tasks`;
/**
 * Where finished videos and their last frames are downloaded from: BytePlus's object storage (TOS)
 * in the same region as the API, which names a bucket as the first label. The docs don't list the
 * exact bucket, so any one label under this BytePlus-owned domain is allowed, and nothing else.
 */
export const ASSET_HOSTS = ["*.tos-ap-southeast-1.bytepluses.com"];

/** Seedance makes 24 frames a second at every size (Create task: "fps 24"). */
export const FPS = 24;

/**
 * A size table family. The docs give one column per family, and 2.0 and 1.5 Pro share theirs.
 * Seedance 2.5 differs only at 480p; 1.0 differs from both.
 */
export type SizeFamily = "2.5" | "2.0" | "1.0";

/** One model's wire rules. The manifest is built from this, so offers and payloads can't drift. */
export interface SeedanceSpec {
  /** The id sent on the wire, and ours. */
  modelId: string;
  displayName: string;
  /** Our own copy, 90 characters at most. */
  description: string;
  sizes: SizeFamily;
  resolutions: VideoResolution[];
  defaultResolution: VideoResolution;
  /** Shortest and longest whole seconds. */
  seconds: [number, number];
  endFrame: boolean;
  /** generate_audio. */
  audio: boolean;
  /** seed and camera_fixed: the 1.x models only. */
  seedAndCamera: boolean;
  autoAspect: VideoCapability["autoAspect"];
  startFrameForcesAuto: boolean;
  /** From the model list: 3 at once for individual accounts on 2.x, 10 on 1.x. */
  maxConcurrent: number;
  price: PriceModel;
  /** Retired at BytePlus, still callable. */
  legacy?: boolean;
  /** Its largest size comes as 10-bit HEVC, which some browsers can't play. */
  hevc?: boolean;
}

/** In chip order. "auto" is BytePlus's "adaptive": the model picks, or takes the start frame's shape. */
export const RATIOS: AspectRatio[] = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "auto"];
const WIRE_RATIOS: Partial<Record<AspectRatio, string>> = {
  "16:9": "16:9",
  "4:3": "4:3",
  "1:1": "1:1",
  "3:4": "3:4",
  "9:16": "9:16",
  "21:9": "21:9",
  auto: "adaptive",
};
export const wireRatio = (ratio: AspectRatio): string | undefined => WIRE_RATIOS[ratio];

type Row = [AspectRatio, number, number];
const rows = (resolution: VideoResolution, list: Row[]): VideoCapability["sizes"] =>
  list.map(([aspect, width, height]) => ({ resolution, aspect, width, height }));

// "Width and height pixel values corresponding to different aspect ratios" (Create task).
const P720: Row[] = [
  ["16:9", 1280, 720],
  ["4:3", 1112, 834],
  ["1:1", 960, 960],
  ["3:4", 834, 1112],
  ["9:16", 720, 1280],
  ["21:9", 1470, 630],
];
const P1080: Row[] = [
  ["16:9", 1920, 1080],
  ["4:3", 1664, 1248],
  ["1:1", 1440, 1440],
  ["3:4", 1248, 1664],
  ["9:16", 1080, 1920],
  ["21:9", 2206, 946],
];
const P480_20: Row[] = [
  ["16:9", 864, 496],
  ["4:3", 752, 560],
  ["1:1", 640, 640],
  ["3:4", 560, 752],
  ["9:16", 496, 864],
  ["21:9", 992, 432],
];

export const SIZE_TABLES: Record<SizeFamily, VideoCapability["sizes"]> = {
  "2.5": [
    ...rows("480p", [
      ["16:9", 854, 480],
      ["4:3", 752, 560],
      ["1:1", 640, 640],
      ["3:4", 560, 752],
      ["9:16", 480, 854],
      ["21:9", 992, 432],
    ]),
    ...rows("720p", P720),
    ...rows("1080p", P1080),
  ],
  "2.0": [
    ...rows("480p", P480_20),
    ...rows("720p", P720),
    ...rows("1080p", P1080),
    ...rows("4k", [
      ["16:9", 3840, 2160],
      ["4:3", 3326, 2494],
      ["1:1", 2880, 2880],
      ["3:4", 2494, 3326],
      ["9:16", 2160, 3840],
      ["21:9", 4398, 1886],
    ]),
  ],
  "1.0": [
    ...rows("480p", [
      ["16:9", 864, 480],
      ["4:3", 736, 544],
      ["1:1", 640, 640],
      ["3:4", 544, 736],
      ["9:16", 480, 864],
      ["21:9", 960, 416],
    ]),
    ...rows("720p", [
      ["16:9", 1248, 704],
      ["4:3", 1120, 832],
      ["1:1", 960, 960],
      ["3:4", 832, 1120],
      ["9:16", 704, 1248],
      ["21:9", 1504, 640],
    ]),
    ...rows("1080p", [
      ["16:9", 1920, 1088],
      ["4:3", 1664, 1248],
      ["1:1", 1440, 1440],
      ["3:4", 1248, 1664],
      ["9:16", 1088, 1920],
      ["21:9", 2176, 928],
    ]),
  ],
};

/** Frames: jpeg, png and webp are what Openfield stores, and BytePlus takes all three. */
export const FRAME_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** "Less than 30 MB" per image. */
export const FRAME_MAX_BYTES = 30 * 1024 * 1024;
/** Each side of a frame, in pixels, and its width over height. */
export const FRAME_EDGE: [number, number] = [300, 6000];
export const FRAME_RATIO: [number, number] = [0.4, 2.5];
/** The seed range BytePlus takes, without -1 (random), which Openfield never sends. */
export const SEED_RANGE: [number, number] = [0, 2_147_483_647];

const OPS: Capabilities["ops"] = {
  textToImage: false,
  imageEdit: false,
  inpaint: false,
  outpaint: false,
  upscale: false,
  removeBackground: false,
  detectText: false,
  decomposeLayers: false,
};

// Reference images (Seedance's omni mode) are out of scope for now: frames only.
const NO_REFERENCES: Capabilities["references"] = {
  supported: false,
  max: 0,
  roles: [],
  mimeTypes: [],
  maxBytes: 0,
  weights: false,
  strengthMode: "none",
};

const CONTROL_ORDER: ControlId[] = ["model", "aspect", "seed"];

export function seedanceCapabilities(spec: SeedanceSpec): Capabilities {
  const [shortest, longest] = spec.seconds;
  const durations = Array.from({ length: longest - shortest + 1 }, (_, i) => shortest + i);
  return {
    ops: OPS,
    references: NO_REFERENCES,
    size: { mode: "aspect", ratios: RATIOS, default: "16:9" },
    // One video per run: each is its own task, priced and billed on its own.
    batch: { max: 1, native: false },
    seed: spec.seedAndCamera
      ? { supported: true, range: SEED_RANGE, echoed: true }
      : { supported: false, echoed: false },
    negativePrompt: false,
    promptEnhance: "none",
    styleStrength: false,
    transparency: false,
    streaming: { partialImages: false, progressPercent: false },
    // Unused on a video; the file comes back as the company made it (mp4).
    output: { formats: ["png"], default: "png" },
    ...(spec.hevc && { safety: { notices: [t("video.hevc")] } }),
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    limits: {
      // Each call (create, status read, download) on its own; the run's deadline is the video one.
      requestTimeoutMs: 120_000,
      // Not measured: nobody has run these live yet.
      typicalLatencyMs: [60_000, 300_000],
      maxConcurrent: spec.maxConcurrent,
    },
    controlOrder: CONTROL_ORDER,
    ...(!spec.seedAndCamera && {
      unsupported: { seed: { reason: t("composer.chips.seed.unsupported", { model: spec.displayName }) } },
    }),
    unsupportedParamPolicy: "drop-with-warning",
    video: {
      resolutions: spec.resolutions,
      defaultResolution: spec.defaultResolution,
      durations,
      defaultDuration: 5,
      fps: FPS,
      sizes: SIZE_TABLES[spec.sizes].filter((s) => spec.resolutions.includes(s.resolution)),
      frames: { start: true, end: spec.endFrame, mimeTypes: FRAME_MIME_TYPES, maxBytes: FRAME_MAX_BYTES },
      autoAspect: spec.autoAspect,
      startFrameForcesAuto: spec.startFrameForcesAuto,
      audio: { supported: spec.audio, default: spec.audio },
      cameraFixed: spec.seedAndCamera,
    },
  };
}
