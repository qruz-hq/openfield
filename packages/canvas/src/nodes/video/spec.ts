import {
  type AspectRatio,
  type ModelKey,
  type ModelListItem,
  type SizeSpec,
  type VideoResolution,
  videoResolutionSchema,
} from "@openfield/core";
import { estimate, resolveVideo } from "@openfield/providers/manifest";
import { speedOf } from "../../engine/context-base";
import { imageCount, imagesOf, joinPrompt, modelBlocker, planValue, textOf } from "../../engine/inputs";
import type {
  EngineContext,
  EngineNode,
  FingerprintParams,
  NodeEngine,
  PortSpec,
  ResolvedInputs,
  RunCall,
  RunInput,
} from "../../engine/types";
import { pinnedSeed } from "../generate/spec";
import { readBoolean, readModel, readSeed, readSize, readString, type SeedParam } from "../params";
import type { NodeSpec } from "../registry";

// Video (§7, video.generate): a prompt from upstream plus its own text, an optional start frame and
// end frame, and the video model's settings (in the inspector). One video per run; a list of images
// into a frame input runs it once per image, like any single input. No React here: the web app adds
// the card and the inspector on top (apps/web nodes/catalogue.ts).

export interface VideoParams {
  model?: ModelKey;
  /** The node's own text, after anything upstream. */
  prompt: string;
  /** An aspect ratio, or auto (the model's own shape, or the start frame's). Unset: the model's default. */
  size?: SizeSpec;
  /** Unset: the model's default. */
  resolution?: VideoResolution;
  /** Whole seconds. Unset: the model's default. */
  seconds?: number;
  /** Sound, where the model makes it. Unset: the model's default. */
  sound?: boolean;
  /** A still camera, where the model offers it. */
  cameraFixed: boolean;
  seed: SeedParam;
}

export const VIDEO_PORTS: readonly PortSpec[] = [
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
    id: "start_frame",
    label: "canvas.nodes.ports.startFrame",
    direction: "in",
    type: "image",
    arity: "single",
    items: "one",
    required: false,
    binding: { to: "start_frame" },
  },
  {
    id: "end_frame",
    label: "canvas.nodes.ports.endFrame",
    direction: "in",
    type: "image",
    arity: "single",
    items: "one",
    required: false,
    binding: { to: "end_frame" },
  },
  {
    id: "video",
    label: "canvas.nodes.ports.video",
    direction: "out",
    type: "video",
    arity: "single",
    items: "list",
    required: false,
  },
];

/**
 * Where a frame is connected but its image doesn't exist yet: the model's rules only ask whether
 * there is one, never which.
 */
const FRAME_STAND_IN = "00000000000000000000000000";

/** Upstream text, then the node's own. */
export const videoPrompt = (node: EngineNode<VideoParams>, inputs: ResolvedInputs): string =>
  joinPrompt([...textOf(inputs, "prompt"), node.params.prompt]);

/** The model a Video node asks for, or the default video model when it names none. */
export const videoModelKeyOf = (key: ModelKey | undefined, ctx: EngineContext): ModelKey | null =>
  key ?? ctx.defaultVideoModel ?? null;

/** The ratio a node's size asks for, as the model can make it: unset or unknown is its default. */
function aspectFor(model: ModelListItem, size: SizeSpec | undefined): AspectRatio {
  const caps = model.capabilities.size;
  const fallback = caps.mode === "aspect" ? caps.default : "16:9";
  if (!size) return fallback;
  const asked: AspectRatio = size.kind === "auto" ? "auto" : size.kind === "aspect" ? size.ratio : fallback;
  return caps.mode === "aspect" && caps.ratios.includes(asked) ? asked : fallback;
}

/**
 * What a run of this node sends: the size and video settings after the model's rules, exactly as
 * normalize() will freeze them. `hasStart` says whether a start frame is connected, which can
 * decide the shape.
 */
export function videoSettings(model: ModelListItem, p: VideoParams, hasStart: boolean) {
  const { video, aspect } = resolveVideo(
    model,
    {
      ...(p.seconds !== undefined && { seconds: p.seconds }),
      ...(p.resolution && { resolution: p.resolution }),
      ...(p.sound !== undefined && { audio: p.sound }),
      ...(p.cameraFixed && { cameraFixed: true }),
      ...(hasStart && { startFrame: { assetId: FRAME_STAND_IN } }),
    },
    aspectFor(model, p.size),
  );
  const { startFrame: _start, endFrame: _end, ...settings } = video;
  const size: SizeSpec = aspect === "auto" ? { kind: "auto" } : { kind: "aspect", ratio: aspect };
  return { size, video: settings };
}

function fingerprintParams(node: EngineNode<VideoParams>, ctx: EngineContext): FingerprintParams {
  const p = node.params;
  const key = videoModelKeyOf(p.model, ctx);
  const model = ctx.model(key);
  const seed = model ? pinnedSeed(model, p.seed) : p.seed.mode === "fixed" ? (p.seed.value ?? 0) : null;
  if (!model?.capabilities.video) {
    return {
      params: {
        prompt: p.prompt.trim(),
        size: p.size ?? null,
        resolution: p.resolution ?? null,
        seconds: p.seconds ?? null,
        sound: p.sound ?? null,
        cameraFixed: p.cameraFixed,
        seed: seed ?? "random",
      },
      model: key,
      manifestVersion: null,
      cacheable: true,
    };
  }
  // Unset and "set to the default" resolve to the same values, so they hash the same. The start
  // frame's own fingerprint is upstream's, so its presence alone needn't be hashed here.
  const wire = videoSettings(model, p, false);
  return {
    params: { prompt: p.prompt.trim(), size: wire.size, ...wire.video, seed: seed ?? "random" },
    model: key,
    manifestVersion: model.manifestVersion,
    // A model with seeds makes a new video per run unless one is pinned.
    cacheable: !(model.capabilities.seed.supported && seed === null),
  };
}

export const videoEngine: NodeEngine<VideoParams> = {
  fingerprintParams,

  outputs(node, inputs, _ctx, willRun) {
    const prompt = videoPrompt(node, inputs);
    if (willRun) return { video: [{ kind: "pending", nodeId: node.id, port: "video", expected: 1, prompt }] };
    return {
      video: (node.result?.assetIds ?? []).map((assetId) => ({ kind: "asset" as const, assetId, prompt })),
    };
  },

  blocker(node, inputs, ctx) {
    const key = videoModelKeyOf(node.params.model, ctx);
    const stop = modelBlocker(key, ctx, "video");
    if (stop) return stop;
    const model = ctx.model(key)!;
    const start = imageCount(imagesOf(inputs, "start_frame"));
    const end = imageCount(imagesOf(inputs, "end_frame"));
    // Words, or a frame to start from (normalize() takes either).
    if (!videoPrompt(node, inputs) && start === 0) return { kind: "no_prompt" };
    if (end > 0 && !model.capabilities.video?.frames.end)
      return { kind: "end_frame_unsupported", model: key! };
    if (end > 0 && start === 0) return { kind: "missing_input", port: "start_frame" };
    return null;
  },

  compile(node, inputs, ctx, fingerprint) {
    const key = videoModelKeyOf(node.params.model, ctx)!;
    const model = ctx.model(key)!;
    const p = node.params;
    const prompt = videoPrompt(node, inputs);
    const start = imagesOf(inputs, "start_frame");
    const end = imagesOf(inputs, "end_frame");
    const wire = videoSettings(model, p, start.length > 0);
    const call: RunCall = {
      model: key,
      op: "generate",
      prompt,
      size: wire.size,
      video: wire.video,
      batch: 1,
      seed: pinnedSeed(model, p.seed),
    };
    const frames: RunInput[] = [
      ...(start.length
        ? [
            {
              port: "start_frame",
              to: "start_frame" as const,
              arity: "single" as const,
              values: start.map(planValue),
            },
          ]
        : []),
      ...(end.length
        ? [
            {
              port: "end_frame",
              to: "end_frame" as const,
              arity: "single" as const,
              values: end.map(planValue),
            },
          ]
        : []),
    ];
    // A list into a frame runs the node once per image, as for any single input.
    const fanOut = Math.max(1, imageCount(start)) * Math.max(1, imageCount(end));
    const once = estimate(model, {
      batch: 1,
      op: "generate",
      speed: speedOf(ctx, model),
      size: wire.size.kind === "aspect" ? { aspect: wire.size.ratio } : { aspect: "auto" },
      video: { ...wire.video, ...(start.length > 0 && { startFrame: { assetId: FRAME_STAND_IN } }) },
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
          inputs: frames,
          calls: [call],
          cached: null,
        },
        expectedJobs: fanOut,
        estimate:
          once.confidence === "unknown" ? once : { ...once, min: once.min * fanOut, max: once.max * fanOut },
        fanOut,
      },
    };
  },
};

const readResolution = (value: unknown): VideoResolution | undefined => {
  const parsed = videoResolutionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const readSeconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 60 ? value : undefined;

export const videoSpec: NodeSpec<VideoParams> = {
  type: "video.generate",
  typeVersion: 1,
  label: "canvas.nodes.video.label",
  description: "canvas.nodes.video.description",
  keywords: ["video", "clip", "animate", "motion", "seedance"],
  category: "generate",
  menu: { group: "video", order: 0 },
  // A 16:9 card until the web app's own box takes over.
  size: { w: 320, h: 180 },
  resizable: false,
  annotation: false,
  ports: VIDEO_PORTS,
  defaults: (ctx) => ({
    ...(ctx.defaultVideoModel && { model: ctx.defaultVideoModel }),
    prompt: "",
    cameraFixed: false,
    seed: { mode: "random" },
  }),
  parseParams: (raw) => {
    const size = readSize(raw.size);
    const resolution = readResolution(raw.resolution);
    const seconds = readSeconds(raw.seconds);
    return {
      model: readModel(raw.model),
      prompt: readString(raw, "prompt"),
      // A video is made at a ratio, or the model's own shape: never at exact pixels.
      ...(size && size.kind !== "pixels" && { size }),
      ...(resolution && { resolution }),
      ...(seconds !== undefined && { seconds }),
      ...(typeof raw.sound === "boolean" && { sound: raw.sound }),
      cameraFixed: readBoolean(raw, "cameraFixed"),
      seed: readSeed(raw.seed),
    };
  },
  runnable: true,
  engine: videoEngine,
};
