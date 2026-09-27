import type { NodeSpec } from "./registry";

// Annotation node types: Note, Frame, Text, Shape. They never run and carry no data ports. Note and
// Frame are in the add-node menu; Text and Shape come from the toolbar. The editor draws them
// (apps/web editor/annotations).

export interface NoteParams {
  text: string;
  /** Kept for the tint choices §7.5 lists; the design draws one, so only that renders (§8.7). */
  tint: number;
}

export interface TextParams {
  text: string;
}

export interface ShapeParams {
  shape: "rectangle";
  text: string;
}

/** Smallest boxes the editor's resize handles allow. */
export const NOTE_MIN = { w: 120, h: 80 };
export const FRAME_MIN = { w: 160, h: 120 };
export const SHAPE_MIN = { w: 40, h: 40 };

export const noteSpec: NodeSpec<NoteParams> = {
  type: "note",
  typeVersion: 1,
  label: "canvas.editor.annotations.note",
  description: "canvas.editor.annotations.noteLine",
  keywords: ["sticky", "comment", "annotation"],
  category: "annotation",
  menu: { group: "utilities", order: 1 },
  size: { w: 240, h: 240 },
  minSize: NOTE_MIN,
  resizable: true,
  annotation: true,
  ports: [],
  defaults: () => ({ text: "", tint: 0 }),
  parseParams: (raw) => ({
    text: typeof raw.text === "string" ? raw.text : "",
    tint: typeof raw.tint === "number" && Number.isFinite(raw.tint) ? raw.tint : 0,
  }),
  runnable: false,
};

export const frameSpec: NodeSpec<Record<string, never>> = {
  type: "frame",
  typeVersion: 1,
  label: "canvas.editor.annotations.frame",
  description: "canvas.editor.annotations.frameLine",
  keywords: ["group", "section", "area"],
  category: "annotation",
  menu: { group: "utilities", order: 2 },
  size: { w: 640, h: 420 },
  minSize: FRAME_MIN,
  resizable: true,
  annotation: true,
  ports: [],
  defaults: () => ({}),
  parseParams: () => ({}),
  runnable: false,
};

export const textSpec: NodeSpec<TextParams> = {
  type: "text",
  typeVersion: 1,
  label: "canvas.editor.annotations.text",
  description: "canvas.editor.annotations.textLine",
  keywords: ["heading", "label", "title"],
  category: "annotation",
  // From the toolbar (T) only.
  menu: null,
  size: null,
  resizable: false,
  annotation: true,
  ports: [],
  defaults: () => ({ text: "" }),
  parseParams: (raw) => ({ text: typeof raw.text === "string" ? raw.text : "" }),
  runnable: false,
};

export const shapeSpec: NodeSpec<ShapeParams> = {
  type: "shape",
  typeVersion: 1,
  label: "canvas.editor.annotations.shape",
  description: "canvas.editor.annotations.shapeLine",
  keywords: ["rectangle", "box"],
  category: "annotation",
  // From the toolbar (R) only.
  menu: null,
  size: { w: 210, h: 126 },
  minSize: SHAPE_MIN,
  resizable: true,
  annotation: true,
  ports: [],
  defaults: () => ({ shape: "rectangle", text: "" }),
  parseParams: (raw) => ({ shape: "rectangle", text: typeof raw.text === "string" ? raw.text : "" }),
  runnable: false,
};
