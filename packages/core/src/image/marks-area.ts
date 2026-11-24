import type { Mark } from "../schemas/marks";

// The area a set of marks covers, for keeping the rest of the image: each box and circle as drawn,
// a disc around each point, and the box around each line or arrow with a little room. A model reads
// the marks themselves; this only says what may change. The Edit tab and a canvas run both use it.

/** A point's area: a circle this share of the image's short side across. */
const POINT_AREA = 0.2;
/** How far a line or an arrow's area reaches past it, as a share of the image's short side. */
const LINE_PAD = 0.04;

/** The fractions a mark covers, as a box. */
function boundsOf(mark: Mark): { x0: number; y0: number; x1: number; y1: number } {
  const points =
    mark.kind === "point" ? [mark.at] : mark.kind === "stroke" ? mark.points : [mark.from, mark.to];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Coverage at the image's stored size, row-major: 255 where the marks reach, 0 elsewhere. */
export function marksArea(
  marks: readonly Mark[],
  width: number,
  height: number,
  into?: Uint8Array,
): Uint8Array {
  const data = into ?? new Uint8Array(width * height);
  const short = Math.min(width, height);
  const fill = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    inside: (x: number, y: number) => boolean,
  ) => {
    const left = Math.max(0, Math.floor(x0));
    const top = Math.max(0, Math.floor(y0));
    const right = Math.min(width, Math.ceil(x1));
    const bottom = Math.min(height, Math.ceil(y1));
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) if (inside(x + 0.5, y + 0.5)) data[y * width + x] = 255;
  };
  for (const mark of marks) {
    if (mark.kind === "point") {
      const cx = mark.at.x * width;
      const cy = mark.at.y * height;
      const r = (short * POINT_AREA) / 2;
      fill(cx - r, cy - r, cx + r, cy + r, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
      continue;
    }
    const b = boundsOf(mark);
    let [x0, y0, x1, y1] = [b.x0 * width, b.y0 * height, b.x1 * width, b.y1 * height];
    if (mark.kind === "circle") {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.max(0.5, (x1 - x0) / 2);
      const ry = Math.max(0.5, (y1 - y0) / 2);
      fill(x0, y0, x1, y1, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1);
      continue;
    }
    if (mark.kind !== "box") {
      const pad = short * LINE_PAD;
      [x0, y0, x1, y1] = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    }
    fill(x0, y0, x1, y1, () => true);
  }
  return data;
}
