import { MARK_STROKE_POINTS_MAX, type Mark, type MarkPoint } from "@openfield/core";
import { createMask, type Mask } from "./mask";

// Sketch & point: marks on the image instead of a painted area, for models that read them
// (capabilities.marks). A mark's points are fractions of the image as it's shown, 0 at the top left
// and 1 at the bottom right, which is what POST /api/edit takes. Pure, so tests cover the geometry.

export type SketchTool = "pan" | "brush" | "circle" | "box" | "arrow" | "point";

/** What a fresh sketch starts on, and what Esc goes back to (design VxRpG1BiE8). */
export const DEFAULT_SKETCH_TOOL: SketchTool = "brush";

/** The colour a fresh edit's marks start in: the first preset. */
export const DEFAULT_MARK_COLOR = "#C8102E";

/** Image edit / Mark popover's presets, in order. */
export const MARK_PRESETS = [
  "#C8102E",
  "#E8A33D",
  "#F2D43D",
  "#3FA34D",
  "#1F6FEB",
  "#7A4FD0",
  "#F5F6F7",
  "#14161A",
] as const;

/** The mark kind each drawing tool makes. */
export const MARK_OF_TOOL = {
  brush: "stroke",
  circle: "circle",
  box: "box",
  arrow: "arrow",
  point: "point",
} as const satisfies Record<Exclude<SketchTool, "pan">, Mark["kind"]>;

/** A drag shorter than this, in screen px, is a click: it makes no box, circle or arrow. */
export const MIN_DRAG_PX = 4;

/** A point's area when Keep the rest needs one: a circle this share of the image's short side across. */
const POINT_AREA = 0.2;
/** How far a line or an arrow's area reaches past it, as a share of the image's short side. */
const LINE_PAD = 0.04;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A client point as a fraction of the image's rectangle on screen, kept on the image. */
export function fractionAt(image: Rect, client: { x: number; y: number }): MarkPoint {
  return {
    x: clamp01((client.x - image.left) / image.width),
    y: clamp01((client.y - image.top) / image.height),
  };
}

/** A fraction of the image as a point in `image`'s px (a frame's, or the screen's). */
export const placeAt = (image: Rect, point: MarkPoint) => ({
  x: image.left + point.x * image.width,
  y: image.top + point.y * image.height,
});

/** Corner to corner, top left first, as the API reads a box or a circle. */
export function ordered(from: MarkPoint, to: MarkPoint): { from: MarkPoint; to: MarkPoint } {
  return {
    from: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) },
    to: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y) },
  };
}

/** The points a mark is drawn through. */
export function pointsOf(mark: Mark): readonly MarkPoint[] {
  switch (mark.kind) {
    case "point":
      return [mark.at];
    case "stroke":
      return mark.points;
    default:
      return [mark.from, mark.to];
  }
}

/** The fractions a mark covers, as a box. */
export function boundsOf(mark: Mark): { from: MarkPoint; to: MarkPoint } {
  const points = pointsOf(mark);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    from: { x: Math.min(...xs), y: Math.min(...ys) },
    to: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

/**
 * At most `max` points of a freehand line, evenly picked and always keeping both ends, so a long
 * stroke stays under the API's limit and keeps its shape.
 */
export function thinStroke(points: readonly MarkPoint[], max = MARK_STROKE_POINTS_MAX): MarkPoint[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/** Light enough that the chip's number reads in near-black (design: #14161A on white and yellow). */
export function isLightColor(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** "#c8102e", "c8102e" or "C8102E" as "#C8102E"; null when it isn't a colour. */
export function normalHex(text: string): string | null {
  const hex = text.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

/** Image edit / Marks list / Prompt preview: "Mark 1 · box · #C8102E · brushed steel". */
export function previewLine(mark: Mark, name: string, kind: string): string {
  return [name, kind, mark.color, mark.material].filter(Boolean).join(" · ");
}

/**
 * The area Keep the rest puts the original back outside of, at the image's stored size: each box
 * and circle as drawn, a disc around each point, and the box around each line or arrow with a
 * little room. A model reads the marks themselves; this only says what may change.
 */
export function maskOfMarks(marks: readonly Mark[], width: number, height: number): Mask {
  const mask = createMask(width, height);
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
      for (let x = left; x < right; x++) if (inside(x + 0.5, y + 0.5)) mask.data[y * width + x] = 255;
  };
  for (const mark of marks) {
    if (mark.kind === "point") {
      const cx = mark.at.x * width;
      const cy = mark.at.y * height;
      const r = (short * POINT_AREA) / 2;
      fill(cx - r, cy - r, cx + r, cy + r, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
      continue;
    }
    const { from, to } = boundsOf(mark);
    let [x0, y0, x1, y1] = [from.x * width, from.y * height, to.x * width, to.y * height];
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
  return mask;
}

/** The marks as POST /api/edit takes them: boxes and circles corner to corner, top left first. */
export function marksForApi(marks: readonly Mark[]): Mark[] {
  return marks.map((mark) =>
    mark.kind === "box" || mark.kind === "circle" ? { ...mark, ...ordered(mark.from, mark.to) } : mark,
  );
}

/** Image edit / Mark chip: 22 across, its centre placed by the mark's kind (design 2bV3EseFV4). */
export const CHIP_PX = 22;

/**
 * Where a mark's numbered chip is centred, in `image`'s px: on a box's top left corner, just inside
 * a circle's, up and to the right of a point's dot, and at the start of a line or an arrow.
 */
export function chipCenter(mark: Mark, image: Rect): { x: number; y: number } {
  switch (mark.kind) {
    case "point": {
      const at = placeAt(image, mark.at);
      return { x: at.x + 15, y: at.y - 15 };
    }
    case "box":
      return placeAt(image, boundsOf(mark).from);
    case "circle": {
      const corner = placeAt(image, boundsOf(mark).from);
      return { x: corner.x + 3, y: corner.y + 3 };
    }
    case "stroke":
      return placeAt(image, mark.points[0]!);
    case "arrow":
      return placeAt(image, mark.from);
  }
}

/** The mark whose chip is under a client point, the last drawn first; null when none is. */
export function chipAt(marks: readonly Mark[], image: Rect, client: { x: number; y: number }): number | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const c = chipCenter(marks[i]!, image);
    if ((c.x - client.x) ** 2 + (c.y - client.y) ** 2 <= (CHIP_PX / 2) ** 2) return i;
  }
  return null;
}
