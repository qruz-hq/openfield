import { isDrawnMark, type Mark, type MarkPoint, toEditGrid } from "@openfield/core";
import type { MarkDrawing } from "../types";

// Marks to Seedream's interactive editing (5.0 Pro and Flash editing guide, which 5.5 follows too).
// Points and boxes become <point>x y</point> and <bbox>x1 y1 x2 y2</bbox> tags on the 0 to 999
// grid, after "Image n", the image they're on. Circles, strokes and arrows have no tag: they're
// drawn onto that image in a colour of their own, and the prompt names them by it. A mark's note and
// material go next to it in words, since the API has no field for them. Its colour is only how
// Openfield shows the mark, so it's never sent: the model would paint the marked thing that colour.
// Pure, so tests snapshot it.

/** Inks for drawn marks, picked to stand out on most photos. Cycled in mark order. */
export const MARK_INKS = [
  { hex: "#FF2D2D", name: "red" },
  { hex: "#2D7BFF", name: "blue" },
  { hex: "#22C55E", name: "green" },
  { hex: "#FACC15", name: "yellow" },
  { hex: "#D946EF", name: "magenta" },
  { hex: "#06B6D4", name: "cyan" },
] as const;

/** Line width of a drawn mark, as a share of the image's short side. */
export const MARK_LINE = 0.006;

export interface MarkedPrompt {
  prompt: string;
  /** What to draw, by image number (1 is the first image sent). Empty when nothing is drawn. */
  drawings: Map<number, MarkDrawing[]>;
}

const point = (p: MarkPoint) => `<point>${toEditGrid(p.x)} ${toEditGrid(p.y)}</point>`;

function bbox(points: readonly MarkPoint[]): string {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x1, x2] = [toEditGrid(Math.min(...xs)), toEditGrid(Math.max(...xs))];
  const [y1, y2] = [toEditGrid(Math.min(...ys)), toEditGrid(Math.max(...ys))];
  return `<bbox>${x1} ${y1} ${x2} ${y2}</bbox>`;
}

const SHAPE_NAMES = { circle: "circle", stroke: "line", arrow: "arrow" } as const;

/** The person's prompt, then one line per mark, then a line asking for drawn marks to go. */
export function promptWithMarks(prompt: string, marks: readonly Mark[] | undefined): MarkedPrompt {
  const drawings = new Map<number, MarkDrawing[]>();
  if (!marks?.length) return { prompt, drawings };
  let inks = 0;
  const lines = marks.map((mark, i) => {
    const image = `Image ${mark.image ?? 1}`;
    let where: string;
    if (mark.kind === "point") where = `${image} ${point(mark.at)}`;
    else if (mark.kind === "box") where = `${image} ${bbox([mark.from, mark.to])}`;
    else {
      const ink = MARK_INKS[inks++ % MARK_INKS.length]!;
      const points = mark.kind === "stroke" ? mark.points : [mark.from, mark.to];
      const list = drawings.get(mark.image ?? 1) ?? [];
      list.push({ kind: mark.kind, points, color: ink.hex, width: MARK_LINE });
      drawings.set(mark.image ?? 1, list);
      const shape = `the ${ink.name} ${SHAPE_NAMES[mark.kind]} drawn on ${image}`;
      where =
        mark.kind === "arrow"
          ? `${shape}, from ${point(mark.from)} to ${point(mark.to)}`
          : `${shape}, around ${image} ${bbox(points)}`;
    }
    const details = [
      mark.note && sentence(mark.note),
      mark.material && `Make it look like ${mark.material.replace(/[.\s]+$/, "")}.`,
    ].filter(Boolean);
    return `${i + 1}. ${capitalise(where)}${details.length ? `: ${details.join(" ")}` : "."}`;
  });
  const drawn = marks.some(isDrawnMark);
  const text = [
    prompt.trim(),
    `Marked places:\n${lines.join("\n")}`,
    ...(drawn ? ["Remove every drawn mark from the result."] : []),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { prompt: text, drawings };
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const sentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};
