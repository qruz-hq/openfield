import { cardLayout, restBox, restKey } from "@openfield/canvas/nodes/generate/card-size";
import type { NodeSpec } from "@openfield/canvas/nodes/registry";
import { cardMedia } from "../generate/card-media";

// The Video card's box follows the same rule as Generate's (card-size.ts is modality-agnostic:
// an asset id and its pixel size, nothing image-specific), so it shares Generate's store rather
// than keeping a second one. A video's asset id never collides with an image's.

export const videoBox: NonNullable<NodeSpec["box"]> = ({ frame, params, result, ctx }) => {
  const { w, h } = cardLayout({ frame, params, result, ctx, media: cardMedia.getState() });
  return { w, h };
};

export const videoRest: NonNullable<NodeSpec["rest"]> = {
  key: ({ params, result }) => restKey(params, result),
  box: (input) => restBox(input, cardMedia.getState()),
};
