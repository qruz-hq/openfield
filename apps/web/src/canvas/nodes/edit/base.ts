import type { NodeAnalysis } from "../../engine/analysis";

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
