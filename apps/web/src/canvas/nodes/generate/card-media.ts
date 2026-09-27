import {
  type CardMediaView,
  cardLayout,
  type ImageSize,
  restBox,
  restKey,
} from "@openfield/canvas/nodes/generate/card-size";
import type { NodeSpec } from "@openfield/canvas/nodes/registry";
import { createStore } from "zustand/vanilla";

// What the Generate cards know about their images, outside the document: each image's size and
// which image a card with several shows. The card takes the shape of the image on show, so both
// feed the node's box (card-size.ts). Exact sizes come from the image's own record: the run that
// made it (job.output) or the canvas as it opens (assetSizes). A thumbnail's size is a rounded
// stand-in that only draws the card until the exact one arrives; it's never saved.

export const cardMedia = createStore<CardMediaView>()(() => ({ dims: {}, shown: {} }));

/**
 * An image's pixel size. Images never change, so an exact size, once known, stands; a thumbnail's
 * only fills in until then.
 */
export function rememberImageSize(
  assetId: string,
  w: number,
  h: number,
  opts: { approx?: boolean } = {},
): void {
  if (!(w > 0 && h > 0)) return;
  const { dims } = cardMedia.getState();
  const known = dims[assetId];
  if (known && (!known.approx || opts.approx)) return;
  const size: ImageSize = opts.approx ? { w, h, approx: true } : { w, h };
  cardMedia.setState({ dims: { ...dims, [assetId]: size } });
}

/** Exact sizes for many images at once, as a canvas opens. */
export function rememberImageSizes(
  sizes: Readonly<Record<string, { w: number; h: number }>> | undefined,
): void {
  if (!sizes) return;
  const { dims } = cardMedia.getState();
  const next = { ...dims };
  let changed = false;
  for (const [assetId, { w, h }] of Object.entries(sizes)) {
    const known = next[assetId];
    if ((known && !known.approx) || !(w > 0 && h > 0)) continue;
    next[assetId] = { w, h };
    changed = true;
  }
  if (changed) cardMedia.setState({ dims: next });
}

/** The pager: which of its images a card shows. */
export function showImage(nodeId: string, assetId: string): void {
  const { shown } = cardMedia.getState();
  if (shown[nodeId] === assetId) return;
  cardMedia.setState({ shown: { ...shown, [nodeId]: assetId } });
}

/**
 * Generate's box in the editor: the card takes the shape of the image on show, which only the
 * browser has measured, so the node type's spec (@openfield/canvas) leaves it to this.
 */
export const generateBox: NonNullable<NodeSpec["box"]> = ({ frame, params, result, ctx }) => {
  const { w, h } = cardLayout({ frame, params, result, ctx, media: cardMedia.getState() });
  return { w, h };
};

export const generateRest: NonNullable<NodeSpec["rest"]> = {
  key: ({ params, result }) => restKey(params, result),
  box: (input) => restBox(input, cardMedia.getState()),
};
