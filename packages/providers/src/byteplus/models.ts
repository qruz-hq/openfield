import type { ModelManifest } from "@openfield/core";
import { type SeedanceSpec, seedanceCapabilities } from "./capabilities";
import { PRICES } from "./pricing";

// The static catalog: every Seedance model on ModelArk that makes a video from words or frames,
// checked against the Create task reference and the model list on 2026-09-29. Our ids are
// BytePlus's own, so the wire id and the key agree.

export const SPECS: readonly SeedanceSpec[] = [
  {
    modelId: "dreamina-seedance-2-5-260628",
    displayName: "Seedance 2.5",
    description: "The newest Seedance. Up to 30 seconds with sound, at up to 1080p.",
    sizes: "2.5",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    seconds: [4, 30],
    endFrame: true,
    audio: true,
    seedAndCamera: false,
    autoAspect: "always",
    startFrameForcesAuto: true,
    maxConcurrent: 3,
    price: PRICES["dreamina-seedance-2-5-260628"],
    hevc: true,
  },
  {
    modelId: "dreamina-seedance-2-0-260128",
    displayName: "Seedance 2.0",
    description: "Up to 15 seconds with sound, at up to 4K.",
    sizes: "2.0",
    resolutions: ["480p", "720p", "1080p", "4k"],
    defaultResolution: "720p",
    seconds: [4, 15],
    endFrame: true,
    audio: true,
    seedAndCamera: false,
    autoAspect: "always",
    startFrameForcesAuto: false,
    maxConcurrent: 3,
    price: PRICES["dreamina-seedance-2-0-260128"],
    hevc: true,
  },
  {
    modelId: "dreamina-seedance-2-0-fast-260128",
    displayName: "Seedance 2.0 Fast",
    description: "Quicker and cheaper than 2.0, at 480p or 720p.",
    sizes: "2.0",
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    seconds: [4, 15],
    endFrame: true,
    audio: true,
    seedAndCamera: false,
    autoAspect: "always",
    startFrameForcesAuto: false,
    maxConcurrent: 3,
    price: PRICES["dreamina-seedance-2-0-fast-260128"],
  },
  {
    modelId: "dreamina-seedance-2-0-mini-260615",
    displayName: "Seedance 2.0 Mini",
    description: "The lowest-cost 2.0 model, at 480p or 720p.",
    sizes: "2.0",
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    seconds: [4, 15],
    endFrame: true,
    audio: true,
    seedAndCamera: false,
    autoAspect: "always",
    startFrameForcesAuto: false,
    maxConcurrent: 3,
    price: PRICES["dreamina-seedance-2-0-mini-260615"],
  },
  {
    modelId: "seedance-1-5-pro-251215",
    displayName: "Seedance 1.5 Pro",
    description: "Up to 12 seconds with sound, at up to 1080p.",
    // 1.5 Pro shares 2.0's size column.
    sizes: "2.0",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    seconds: [4, 12],
    endFrame: true,
    audio: true,
    seedAndCamera: true,
    autoAspect: "always",
    startFrameForcesAuto: false,
    maxConcurrent: 10,
    price: PRICES["seedance-1-5-pro-251215"],
    // BytePlus lists it as retired, with 2.0 Mini as the replacement. It still answers.
    legacy: true,
  },
  {
    modelId: "seedance-1-0-pro-250528",
    displayName: "Seedance 1.0 Pro",
    description: "Silent videos up to 12 seconds, at up to 1080p.",
    sizes: "1.0",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "1080p",
    seconds: [2, 12],
    endFrame: true,
    audio: false,
    seedAndCamera: true,
    // Text to video needs a ratio of its own; only a start frame can lend one.
    autoAspect: "with_start_frame",
    startFrameForcesAuto: false,
    maxConcurrent: 10,
    price: PRICES["seedance-1-0-pro-250528"],
  },
  {
    modelId: "seedance-1-0-pro-fast-251015",
    displayName: "Seedance 1.0 Pro Fast",
    description: "Quick, low-cost silent videos, at up to 1080p.",
    sizes: "1.0",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "1080p",
    seconds: [2, 12],
    endFrame: false,
    audio: false,
    seedAndCamera: true,
    autoAspect: "with_start_frame",
    startFrameForcesAuto: false,
    maxConcurrent: 10,
    price: PRICES["seedance-1-0-pro-fast-251015"],
  },
];

const byId = new Map(SPECS.map((s) => [s.modelId, s]));

export const specFor = (modelId: string): SeedanceSpec | undefined => byId.get(modelId);

function manifestOf(spec: SeedanceSpec): ModelManifest {
  return {
    key: `byteplus:${spec.modelId}`,
    providerId: "byteplus",
    modelId: spec.modelId,
    displayName: spec.displayName,
    description: spec.description,
    family: "Seedance",
    modality: "video",
    ...(spec.legacy && { badges: ["legacy" as const] }),
    capabilities: seedanceCapabilities(spec),
    price: spec.price,
    // A task queue: the id arrives at once and is read later, so a restart picks the video up.
    resumableSpeeds: ["standard"],
    source: "static",
    manifestVersion: "1",
    fetchedAt: "2026-09-29",
  };
}

export const BYTEPLUS_MODELS: readonly ModelManifest[] = SPECS.map(manifestOf);
