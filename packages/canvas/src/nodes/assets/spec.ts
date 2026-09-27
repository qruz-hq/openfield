import { readAssetIds } from "../params";
import type { NodeSpec } from "../registry";
import { IMAGE_LIST_PORTS, type ImageListParams, imageListEngine } from "../upload/spec";

// Assets (design x3MoC, empty pRq6B): images picked from the library. Folder mode (mode, folderId,
// limit) waits for folders; params written by a later build stay in the document untouched.

export const assetsSpec: NodeSpec<ImageListParams> = {
  type: "image.asset",
  typeVersion: 1,
  label: "canvas.nodes.assets.label",
  description: "canvas.nodes.assets.description",
  keywords: ["library", "images", "reference", "pick"],
  category: "reference",
  menu: { group: "references", order: 1 },
  size: { w: 280, h: 280 },
  resizable: false,
  annotation: false,
  ports: IMAGE_LIST_PORTS,
  defaults: () => ({ assetIds: [] }),
  parseParams: (raw) => ({ assetIds: readAssetIds(raw.assetIds) }),
  runnable: false,
  engine: imageListEngine,
};
