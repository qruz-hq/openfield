import type { NodeEngine, PortSpec } from "../../engine/types";
import { readAssetIds } from "../params";
import type { NodeSpec } from "../registry";

// Upload (design GTnB2, empty d0l3m): images from this computer, in the order shown. Each file is
// stored in the library once (POST /api/uploads), so the node only keeps asset ids.

export interface ImageListParams {
  assetIds: string[];
}

export const IMAGE_LIST_PORTS: readonly PortSpec[] = [
  {
    id: "images",
    label: "canvas.nodes.ports.images",
    direction: "out",
    type: "image",
    arity: "single",
    items: "list",
    required: false,
  },
];

export const imageListEngine: NodeEngine<ImageListParams> = {
  fingerprintParams: (node) => ({
    params: { assetIds: node.params.assetIds },
    model: null,
    manifestVersion: null,
    cacheable: true,
  }),
  // Images that aren't in this library (a canvas from another computer) stay out of runs: the node
  // shows a placeholder for them and the rest still runs (§7.8).
  outputs: (node, _inputs, ctx) => ({
    images: node.params.assetIds
      .filter((assetId) => !ctx.missing?.has(assetId))
      .map((assetId) => ({ kind: "asset" as const, assetId })),
  }),
  blocker: () => null,
};

export const uploadSpec: NodeSpec<ImageListParams> = {
  type: "image.upload",
  typeVersion: 1,
  label: "canvas.nodes.upload.label",
  description: "canvas.nodes.upload.description",
  keywords: ["file", "photo", "reference", "import"],
  category: "reference",
  menu: { group: "references", order: 0 },
  size: { w: 280, h: 280 },
  resizable: false,
  annotation: false,
  ports: IMAGE_LIST_PORTS,
  defaults: () => ({ assetIds: [] }),
  parseParams: (raw) => ({ assetIds: readAssetIds(raw.assetIds) }),
  runnable: false,
  engine: imageListEngine,
};
