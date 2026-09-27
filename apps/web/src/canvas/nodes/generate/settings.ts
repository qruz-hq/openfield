import type { ModelListItem, ResolutionTier, SizeSpec } from "@openfield/core";
import {
  type ComposerValues,
  carryValues,
  generateBody,
  qualityLabel,
  type Resolved,
  resolveValues,
} from "@openfield/providers/manifest";
import type { EngineContext } from "../../engine/types";

// Size, resolution and quality on a node, read through the composer's own rules (lib/controls):
// unset means "the model's default", and a value the model doesn't offer falls back the same way.
// Never the person's Settings: a saved canvas has to make the same size on any computer, and
// changing a setting mustn't put finished nodes out of date (§0.11). A new node stores the default
// aspect ratio in its params instead (newNodeSize).

export interface SizeParams {
  size?: SizeSpec;
  resolution?: ResolutionTier;
  quality?: string;
}

/** The composer's view of a node's size params: an aspect ratio, a tier and a quality id. */
export function composerValues(params: SizeParams): ComposerValues {
  const size = params.size;
  return {
    aspect: size?.kind === "aspect" ? size.ratio : size?.kind === "auto" ? "auto" : undefined,
    resolution: params.resolution,
    quality: params.quality,
  };
}

/** What each chip shows and each run sends for this model. */
export const resolveFor = (model: ModelListItem, params: SizeParams, batch: number): Resolved =>
  resolveValues(model.capabilities, composerValues(params), batch, null);

/** Like resolveFor, but a value this model lacks moves to its nearest one first (Variations' Models mode). */
export function carriedFor(model: ModelListItem, params: SizeParams): Resolved {
  const carried = carryValues(model.capabilities, composerValues(params), 1, { quality: qualityLabel });
  return resolveValues(model.capabilities, carried.values, 1, null);
}

/** A new node's size: Settings → Defaults → Aspect, written into the node so it stays put. */
export const newNodeSize = (ctx: EngineContext): { size?: SizeSpec } =>
  ctx.defaultAspect ? { size: sizeFromAspect(ctx.defaultAspect) } : {};

/** The request fields these values become, exactly as the composer would send them. */
export function wireSettings(
  model: ModelListItem,
  resolved: Resolved,
): { size: SizeSpec; resolution?: ResolutionTier; quality?: string } {
  const body = generateBody(model, resolved, "", "");
  return {
    size: body.size,
    ...(body.resolution && { resolution: body.resolution }),
    ...(body.quality && { quality: body.quality }),
  };
}

/** Size params back from a picked aspect ratio. */
export const sizeFromAspect = (aspect: string): SizeSpec =>
  aspect === "auto" ? { kind: "auto" } : ({ kind: "aspect", ratio: aspect } as SizeSpec);
