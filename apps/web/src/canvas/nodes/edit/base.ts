import type { NodeAnalysis } from "../../engine/analysis";

// What an Edit node edits, as the editor reads it from the live analysis.

/**
 * The one image coming in to be edited, which a mask is painted on. Null with none, with one still
 * to come from a node upstream, or with several (each would need its own mask).
 */
export function soleBase(analysis: Pick<NodeAnalysis, "baseImages"> | undefined): string | null {
  const images = analysis?.baseImages ?? [];
  return images.length === 1 ? (images[0] ?? null) : null;
}
