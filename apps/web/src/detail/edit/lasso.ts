import type { Point } from "./mask";

// The lasso while it's being drawn (design EM7Gq6YTHg): "Drag to draw, or click to add points.
// Double-click to close." A drag that starts a lasso draws it freehand and closes when the button
// comes up. A click instead starts placing corners: each click adds one, the line follows the pointer
// to where the next would go, and a double-click, or a click back on the first corner, closes it.
// Pure, so the rules are tested without a DOM. Points are image pixels; `scale` is screen px per image
// px, so the distances below feel the same at any zoom.

/** Screen px a press may wander before it counts as a drag. */
const DRAG_PX = 4;
/** Screen px between the points a freehand drag keeps. */
const SPACING_PX = 3;
/** Screen px from the first corner that closes the lasso. */
const CLOSE_PX = 8;

export interface LassoDraft {
  points: Point[];
  /** Which points were clicked into place (drawn as dots), by index. */
  corners: number[];
  /** Where the next corner would go, for the line that follows the pointer. */
  pointer: Point | null;
  /** The press in progress: where it went down, whether it became a drag, and whether it began the lasso. */
  press: { at: Point; dragging: boolean; first: boolean } | null;
}

export interface LassoStep {
  draft: LassoDraft | null;
  /** The finished outline, to paint, once the lasso closes with enough corners for an area. */
  closed?: Point[];
}

const far = (a: Point, b: Point, px: number, scale: number) => Math.hypot(a.x - b.x, a.y - b.y) * scale > px;

/** Three corners make the smallest area; fewer close to nothing. */
function close(draft: LassoDraft): LassoStep {
  return draft.points.length >= 3 ? { draft: null, closed: draft.points } : { draft: null };
}

export function lassoDown(draft: LassoDraft | null, at: Point, scale: number): LassoStep {
  if (!draft) {
    return {
      draft: { points: [at], corners: [0], pointer: null, press: { at, dragging: false, first: true } },
    };
  }
  if (draft.points.length >= 3 && !far(at, draft.points[0]!, CLOSE_PX, scale)) return close(draft);
  const last = draft.points.at(-1)!;
  // A double-click's second press lands on the corner the first just placed.
  const points = far(at, last, DRAG_PX, scale) ? [...draft.points, at] : draft.points;
  const corners = points === draft.points ? draft.corners : [...draft.corners, points.length - 1];
  return { draft: { points, corners, pointer: null, press: { at, dragging: false, first: false } } };
}

export function lassoMove(draft: LassoDraft | null, at: Point, scale: number): LassoStep {
  if (!draft) return { draft };
  const { press } = draft;
  if (!press) return { draft: { ...draft, pointer: at } };
  const dragging = press.dragging || far(at, press.at, DRAG_PX, scale);
  if (!dragging) return { draft };
  const last = draft.points.at(-1)!;
  const points = far(at, last, SPACING_PX, scale) ? [...draft.points, at] : draft.points;
  return { draft: { ...draft, points, pointer: null, press: { ...press, dragging } } };
}

export function lassoUp(draft: LassoDraft | null, at: Point, scale: number): LassoStep {
  if (!draft?.press) return { draft };
  const moved = lassoMove(draft, at, scale).draft!;
  if (moved.press?.dragging && moved.press.first) return close(moved);
  return { draft: { ...moved, press: null, pointer: at } };
}

/** A double-click closes it. */
export const lassoDoubleClick = (draft: LassoDraft | null): LassoStep => (draft ? close(draft) : { draft });
