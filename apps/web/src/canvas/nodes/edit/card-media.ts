import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { type CardLayout, cardLayout, restBox } from "@openfield/canvas/nodes/generate/card-size";
import type { NodeSpec } from "@openfield/canvas/nodes/registry";
import type { NodeFrame } from "@openfield/canvas/store/ops";
import { cardMedia, type EditorCardMedia } from "../generate/card-media";

// The Edit card's box (design nRuORN2ZyA) follows Generate's rule (card-size.ts) with one change:
// before it has an image of its own it shows the image coming in, and takes that one's shape. It
// has no aspect ratio of its own, so with neither it's square.

const NO_PARAMS: Readonly<Record<string, unknown>> = {};

/** The image coming in, for an Edit card with none of its own yet; null to forget it. */
export function showBase(nodeId: string, assetId: string | null): void {
  const { bases } = cardMedia.getState();
  if ((bases[nodeId] ?? null) === assetId) return;
  const next = { ...bases };
  if (assetId) next[nodeId] = assetId;
  else delete next[nodeId];
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
