import type { NodeAnalysis } from "../../engine/analysis";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas } from "../../store/context";

// What an Edit node edits, as the editor reads it from the live analysis: the engine's own list
// (editBaseNow), so the editor and a run agree on what a painted mask fits.

/**
 * The one image coming in to be edited, which a mask is painted on. Null with none yet, or with
 * several (each would need its own mask).
 */
export function soleBase(analysis: Pick<NodeAnalysis, "baseImages"> | undefined): string | null {
  const images = analysis?.baseImages ?? [];
  return images.length === 1 ? (images[0] ?? null) : null;
}

/**
 * The image a mask can be painted on now: the one coming in, while it's still in this library (an
 * image deleted for good, or from another computer, can't be opened to paint on).
 */
export function usePaintBase(nodeId: string): string | null {
  const base = soleBase(useNodeAnalysis(nodeId));
  const missing = useCanvas((s) => base !== null && s.missingAssets.has(base));
  return missing ? null : base;
}
