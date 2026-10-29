import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { editSpec } from "@openfield/canvas/nodes/edit/spec";
import { type CardLayout, cardLayout, restBox } from "@openfield/canvas/nodes/generate/card-size";
import type { NodeSpec } from "@openfield/canvas/nodes/registry";
import type { DocSlice, NodeFrame } from "@openfield/canvas/store/ops";
import type { GraphAnalysis } from "../../engine/analysis";
import { cardMedia, type EditorCardMedia } from "../generate/card-media";

// The Edit card's box (design nRuORN2ZyA) follows Generate's rule (card-size.ts) with one change:
// before it has an image of its own it shows the image coming in, and takes that one's shape. It
// has no aspect ratio of its own, so with neither it's square.

const NO_PARAMS: Readonly<Record<string, unknown>> = {};

/**
 * The image coming in for every Edit card with none of its own yet, from the live analysis. Worked
 * out for the whole canvas, not by the cards, so a card that isn't drawn (zoomed out, off screen)
 * still gets its box and its far-zoom tile from it.
 */
export function basesOf(
  doc: Pick<DocSlice, "nodes" | "results">,
  analysis: Pick<GraphAnalysis, "nodes">,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, node] of Object.entries(analysis.nodes)) {
    if (doc.nodes[id]?.type !== editSpec.type || doc.results[id]?.assetIds.length) continue;
    const base = node.baseImages[0];
    if (base) out[id] = base;
  }
  return out;
}

/** Keeps cardMedia.bases in step with the analysis; nodes gone or with images of their own drop out. */
export function syncBases(
  doc: Pick<DocSlice, "nodes" | "results">,
  analysis: Pick<GraphAnalysis, "nodes">,
): void {
  const next = basesOf(doc, analysis);
  const { bases } = cardMedia.getState();
  const keys = Object.keys(next);
  if (keys.length === Object.keys(bases).length && keys.every((id) => bases[id] === next[id])) return;
  cardMedia.setState({ bases: next });
}

/** What the card shows: its own images, else the one coming in. */
export function editImages(
  nodeId: string,
  result: { assetIds: readonly string[] } | null,
  media: Pick<EditorCardMedia, "bases">,
): readonly string[] {
  const own = result?.assetIds ?? [];
  if (own.length) return own;
  const base = media.bases[nodeId];
  return base ? [base] : [];
}

/** The card's box and the image on show. Its aspect never comes from a model: no context needed. */
export function editLayout(
  frame: Pick<NodeFrame, "id" | "size">,
  result: { assetIds: readonly string[] } | null,
  media: EditorCardMedia,
): CardLayout {
  const assetIds = editImages(frame.id, result, media);
  return cardLayout({ frame, params: NO_PARAMS, result: { assetIds }, ctx: EMPTY_ENGINE_CONTEXT, media });
}

export const editBox: NonNullable<NodeSpec["box"]> = ({ frame, result }) => {
  const { w, h } = editLayout(frame, result, cardMedia.getState());
  return { w, h };
};

/** The saved size follows its own first image only: the one coming in can change under it at any time. */
export const editRest: NonNullable<NodeSpec["rest"]> = {
  key: ({ result }) => {
    const first = result?.assetIds[0];
    return first ? `image:${first}` : "input";
  },
  box: ({ frame, result }) =>
    restBox({ frame, params: NO_PARAMS, result, ctx: EMPTY_ENGINE_CONTEXT }, cardMedia.getState()),
};
