import type { LayerBox } from "../schemas/layers";

// Two grids a model may talk in, kept apart on purpose because they differ by one.
//
// Edit grid (Seedream's <point> and <bbox> tags): integers 0 to 999, top left 0,0. The company's
// own formula, round(x / width × 1000), can reach 1000 at the far edge, so it's held at 999.
//
// Layer grid (a separation's bounding_box.normalized): integers 0 to 1000, where 1000 is the far
// edge. Rounded, so pixels come from the absolute box whenever it's there.

export const EDIT_GRID_MAX = 999;
export const LAYER_GRID_MAX = 1000;

/** A 0 to 1 fraction of the image on the edit grid. */
export function toEditGrid(fraction: number): number {
  const value = Math.round(Math.min(1, Math.max(0, fraction)) * 1000);
  return Math.min(EDIT_GRID_MAX, value);
}

/** A layer grid box to pixels of a canvas this size: [left, top, right, bottom]. */
export function layerGridToPixels(box: readonly number[], width: number, height: number): LayerBox {
  const [l = 0, t = 0, r = 0, b = 0] = box.map((v) => Math.min(LAYER_GRID_MAX, Math.max(0, v)));
  return [
    Math.round((l / LAYER_GRID_MAX) * width),
    Math.round((t / LAYER_GRID_MAX) * height),
    Math.round((r / LAYER_GRID_MAX) * width),
    Math.round((b / LAYER_GRID_MAX) * height),
  ];
}

/** A box's width and height, never below one pixel so a sliver still has somewhere to go. */
export function boxSize(box: LayerBox): { width: number; height: number } {
  return { width: Math.max(1, box[2] - box[0]), height: Math.max(1, box[3] - box[1]) };
}
