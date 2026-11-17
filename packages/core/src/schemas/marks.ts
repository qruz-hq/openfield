import { z } from "zod";
import { hexColorSchema } from "./common";

// Marks: points, boxes and drawn shapes a person puts on an image to say where an edit goes and
// what it should look like there. Coordinates are fractions of the image as it's shown, 0 at the
// top left and 1 at the bottom right, so they don't depend on the size the image is stored at.
// How a model is told about them is the adapter's business (Seedream: <point> and <bbox> tags
// for points and boxes, and the shapes drawn onto the image it's sent).

export const MARK_KINDS = ["point", "box", "circle", "stroke", "arrow"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];
/** Marks a model only sees when they're drawn onto the image it's sent. */
export const DRAWN_MARK_KINDS = ["circle", "stroke", "arrow"] as const satisfies readonly MarkKind[];

export const MARKS_MAX = 20;
export const MARK_STROKE_POINTS_MAX = 500;
export const MARK_MATERIAL_MAX = 80;
export const MARK_NOTE_MAX = 300;

const unit = z.number().min(0).max(1);
export const markPointSchema = z.strictObject({ x: unit, y: unit });

const common = {
  /**
   * Which image the mark is on, counting from 1 in the order they're sent: 1 is the image being
   * edited, then the references in order. Default 1.
   */
  image: z.int().min(1).max(64).optional(),
  /** The colour the marked thing should be. */
  color: hexColorSchema.optional(),
  /** What it should be made of: "brushed steel". */
  material: z.string().trim().min(1).max(MARK_MATERIAL_MAX).optional(),
  /** What to do there, in the person's words. */
  note: z.string().trim().min(1).max(MARK_NOTE_MAX).optional(),
};

export const markSchema = z.discriminatedUnion("kind", [
  /** One spot. The model decides how far the change reaches. */
  z.strictObject({ kind: z.literal("point"), at: markPointSchema, ...common }),
  /** A rectangle, corner to corner. */
  z.strictObject({ kind: z.literal("box"), from: markPointSchema, to: markPointSchema, ...common }),
  /** An ellipse inside the rectangle from one corner to the other. */
  z.strictObject({ kind: z.literal("circle"), from: markPointSchema, to: markPointSchema, ...common }),
  /** A freehand line through these points. */
  z.strictObject({
    kind: z.literal("stroke"),
    points: z.array(markPointSchema).min(2).max(MARK_STROKE_POINTS_MAX),
    ...common,
  }),
  /** An arrow from the tail to the head. */
  z.strictObject({ kind: z.literal("arrow"), from: markPointSchema, to: markPointSchema, ...common }),
]);

export const marksSchema = z.array(markSchema).min(1).max(MARKS_MAX);

export type MarkPoint = z.infer<typeof markPointSchema>;
export type Mark = z.infer<typeof markSchema>;

export const isDrawnMark = (mark: Mark): mark is Extract<Mark, { kind: "circle" | "stroke" | "arrow" }> =>
  (DRAWN_MARK_KINDS as readonly string[]).includes(mark.kind);
