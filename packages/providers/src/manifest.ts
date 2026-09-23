// @openfield/providers/manifest: the browser-safe entry (§0.16 rule 3). It imports only
// @openfield/core and src/manifest/**, so apps/web can price and render controls locally.

export type {
  AspectRatio,
  Capabilities,
  ControlId,
  ControlState,
  CostEstimate,
  ModelKey,
  ModelManifest,
  PerImagePrice,
  PixelSize,
  PriceModel,
  QualityLevel,
  ResolutionTier,
  ResolvedControl,
  SizeCapability,
} from "@openfield/core";
export { type EstimateRequest, estimate } from "./manifest/estimate";
export {
  type ControlResolution,
  isCoreControl,
  resolveControl,
  visibleControls,
} from "./manifest/resolve-control";
export { nearestRatio, placeholderSize, ratioValue, resolveSize } from "./manifest/size";
