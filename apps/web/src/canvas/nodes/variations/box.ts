import type { NodeSpec } from "@openfield/canvas/nodes/registry";
import {
  variationsLayout,
  variationsRestBox,
  variationsRestKey,
} from "@openfield/canvas/nodes/variations/card-size";
import { cardMedia } from "../generate/card-media";

// Variations' box in the editor: the card takes the shape of its images, which only the browser has
// measured (generate/card-media.ts), so the node type's spec (@openfield/canvas) leaves it to this,
// as Generate's does.

export const variationsBoxOf: NonNullable<NodeSpec["box"]> = ({ frame, params, result, ctx }) => {
  const { w, h } = variationsLayout({ frame, params, result, ctx, media: cardMedia.getState() });
  return { w, h };
};

export const variationsRest: NonNullable<NodeSpec["rest"]> = {
  key: ({ params, result }) => variationsRestKey(params, result),
  box: (input) => variationsRestBox(input, cardMedia.getState()),
};
