// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterEach, describe, expect, test } from "bun:test";
import { MARK_STROKE_POINTS_MAX, MARKS_MAX, type Mark, marksSchema } from "@openfield/core";
import { editBody, resolveValues } from "@openfield/providers/manifest";
import { editKey } from "../src/detail/edit/keys";
import { editHasWork, useEditSession } from "../src/detail/edit/session";
import {
  chipAt,
  chipCenter,
  DEFAULT_MARK_COLOR,
  fractionAt,
  isLightColor,
  marksForApi,
  maskOfMarks,
  normalHex,
  previewLine,
  thinStroke,
} from "../src/detail/edit/sketch";
import { sketcher } from "./fixtures";

const session = () => useEditSession.getState();
afterEach(() => {
  session().end();
  session().setMode("paint");
  session().setMarkColor(DEFAULT_MARK_COLOR);
});

/** The image on screen: 510 × 680 at (285, 58), the design's Sketch & point frame. */
const SHOWN = { left: 285, top: 58, width: 510, height: 680 };

describe("mark geometry", () => {
  test("a point on screen is a fraction of the image as shown, kept on it", () => {
    expect(fractionAt(SHOWN, { x: 285 + 255, y: 58 + 170 })).toEqual({ x: 0.5, y: 0.25 });
    // Past the edge clamps to it, so a drag that leaves the image still ends on it.
    expect(fractionAt(SHOWN, { x: 100, y: 900 })).toEqual({ x: 0, y: 1 });
  });

  test("boxes and circles go to the API corner to corner, top left first", () => {
    const marks: Mark[] = [
      { kind: "box", from: { x: 0.6, y: 0.9 }, to: { x: 0.2, y: 0.5 }, color: "#C8102E" },
      { kind: "circle", from: { x: 0.8, y: 0.1 }, to: { x: 0.4, y: 0.3 } },
      { kind: "arrow", from: { x: 0.9, y: 0.9 }, to: { x: 0.1, y: 0.1 } },
    ];
    const sent = marksForApi(marks);
    expect(sent[0]).toEqual({
      kind: "box",
      from: { x: 0.2, y: 0.5 },
      to: { x: 0.6, y: 0.9 },
      color: "#C8102E",
    });
    expect(sent[1]).toEqual({ kind: "circle", from: { x: 0.4, y: 0.1 }, to: { x: 0.8, y: 0.3 } });
    // An arrow keeps its direction: tail, then head.
    expect(sent[2]).toEqual(marks[2]!);
    expect(marksSchema.safeParse(sent).success).toBe(true);
  });

  test("a long line keeps both ends and stays under the API's limit", () => {
    const points = Array.from({ length: 1301 }, (_, i) => ({ x: i / 1300, y: 0.5 }));
    const thin = thinStroke(points);
    expect(thin).toHaveLength(MARK_STROKE_POINTS_MAX);
    expect(thin[0]).toEqual(points[0]!);
    expect(thin.at(-1)).toEqual(points.at(-1)!);
    expect(thinStroke(points.slice(0, 3))).toHaveLength(3);
  });

  test("chips sit where the design puts them, and a press on one finds it", () => {
    const image = { left: 0, top: 0, width: 100, height: 100 };
    const box: Mark = { kind: "box", from: { x: 0.2, y: 0.3 }, to: { x: 0.5, y: 0.6 } };
    const point: Mark = { kind: "point", at: { x: 0.5, y: 0.5 } };
    const circle: Mark = { kind: "circle", from: { x: 0.1, y: 0.1 }, to: { x: 0.3, y: 0.3 } };
    const arrow: Mark = { kind: "arrow", from: { x: 0.9, y: 0.8 }, to: { x: 0.7, y: 0.6 } };
    expect(chipCenter(box, image)).toEqual({ x: 20, y: 30 });
    expect(chipCenter(point, image)).toEqual({ x: 65, y: 35 });
    expect(chipCenter(circle, image)).toEqual({ x: 13, y: 13 });
    expect(chipCenter(arrow, image)).toEqual({ x: 90, y: 80 });
    const marks = [box, point];
    expect(chipAt(marks, image, { x: 64, y: 36 })).toBe(1);
    expect(chipAt(marks, image, { x: 28, y: 30 })).toBe(0);
    expect(chipAt(marks, image, { x: 50, y: 50 })).toBeNull();
  });

  test("Keep the rest's area covers each mark, and nothing else", () => {
    const mask = maskOfMarks(
      [
        { kind: "box", from: { x: 0, y: 0 }, to: { x: 0.25, y: 0.5 } },
        { kind: "point", at: { x: 0.75, y: 0.75 } },
      ],
      100,
      100,
    );
    const at = (x: number, y: number) => mask.data[y * 100 + x];
    expect(at(10, 10)).toBe(255);
    expect(at(24, 49)).toBe(255);
    expect(at(26, 10)).toBe(0);
    // A point covers a disc a fifth of the short side across.
    expect(at(75, 75)).toBe(255);
    expect(at(75, 84)).toBe(255);
    expect(at(75, 87)).toBe(0);
    expect(at(50, 90)).toBe(0);
  });

  test("a circle's area is the ellipse, and a line's reaches a little past it", () => {
    const mask = maskOfMarks(
      [
        { kind: "circle", from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.5 } },
        {
          kind: "stroke",
          points: [
            { x: 0.7, y: 0.7 },
            { x: 0.8, y: 0.7 },
          ],
        },
      ],
      100,
      100,
    );
    const at = (x: number, y: number) => mask.data[y * 100 + x];
    expect(at(25, 25)).toBe(255);
    // The ellipse's corner stays out.
    expect(at(2, 2)).toBe(0);
    expect(at(75, 72)).toBe(255);
    expect(at(75, 66)).toBe(255);
    expect(at(75, 60)).toBe(0);
  });

  test("chip numbers read in near-black on light colours", () => {
    expect(isLightColor("#F5F6F7")).toBe(true);
    expect(isLightColor("#E8A33D")).toBe(true);
    expect(isLightColor("#C8102E")).toBe(false);
    expect(isLightColor("#3FA34D")).toBe(false);
  });

  test("a typed hex takes once it's a whole colour", () => {
    expect(normalHex("c8102e")).toBe("#C8102E");
    expect(normalHex("#1f6feb ")).toBe("#1F6FEB");
    expect(normalHex("#1f6fe")).toBeNull();
    expect(normalHex("red")).toBeNull();
  });

  test("the prompt preview reads as the design writes it", () => {
    const mark: Mark = {
      kind: "box",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      color: "#C8102E",
      material: "brushed steel",
    };
    expect(previewLine(mark, "Mark 1", "box")).toBe("Mark 1 · box · #C8102E · brushed steel");
    expect(previewLine({ kind: "point", at: { x: 0, y: 0 }, color: "#E8A33D" }, "Mark 2", "point")).toBe(
      "Mark 2 · point · #E8A33D",
    );
  });
});

describe("marks in the session", () => {
  const box: Mark = { kind: "box", from: { x: 0.1, y: 0.1 }, to: { x: 0.4, y: 0.4 }, color: "#C8102E" };
  const point: Mark = { kind: "point", at: { x: 0.5, y: 0.5 }, color: "#E8A33D" };

  test("adding picks the new mark; Undo and Redo step through the marks", () => {
    session().start("a", 64, 64);
    session().setMode("sketch");
    session().addMark(box);
    expect(session().selectedMark).toBe(0);
    session().addMark(point);
    expect(session().marks).toEqual([box, point]);
    session().undo();
    expect(session().marks).toEqual([box]);
    expect(session().selectedMark).toBeNull();
    session().redo();
    expect(session().marks).toEqual([box, point]);
    session().removeMark(0);
    expect(session().marks).toEqual([point]);
    session().clearMarks();
    expect(session().marks).toEqual([]);
    session().undo();
    expect(session().marks).toEqual([point]);
  });

  test("a material typed letter by letter is one step for Undo", () => {
    session().start("a", 64, 64);
    session().setMode("sketch");
    session().addMark(box);
    const before = session().marks;
    for (const material of ["b", "br", "brass"]) session().updateMark(0, { material }, false);
    session().recordMarks(before);
    expect(session().marks[0]?.material).toBe("brass");
    session().undo();
    expect(session().marks[0]?.material).toBeUndefined();
    session().undo();
    expect(session().marks).toEqual([]);
  });

  test("no more than the API takes", () => {
    session().start("a", 64, 64);
    session().setMode("sketch");
    for (let i = 0; i < MARKS_MAX + 3; i++) session().addMark(point);
    expect(session().marks).toHaveLength(MARKS_MAX);
  });

  test("marks are work to lose, until a run has saved images from them", () => {
    session().start("a", 64, 64);
    session().setMode("sketch");
    expect(editHasWork()).toBe(false);
    session().addMark(box);
    expect(editHasWork()).toBe(true);
    const { maskVersion, marksVersion } = session();
    session().setKept({ maskVersion, marksVersion, prompt: "", references: [] });
    expect(editHasWork()).toBe(false);
    session().updateMark(0, { color: "#1F6FEB" });
    expect(editHasWork()).toBe(true);
  });

  test("each mode's tools and keys, and Esc puts its first tool back", () => {
    session().start("a", 64, 64);
    session().setMode("sketch");
    expect(
      editKey({ key: "p", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, "sketch"),
    ).toEqual({
      kind: "tool",
      tool: "point",
    });
    session().setTool("box");
    // A paint tool does nothing while sketching.
    session().setTool("lasso");
    expect(session().sketchTool).toBe("box");
    expect(session().tool).toBe("brush");
    expect(session().resetTool()).toBe(true);
    expect(session().sketchTool).toBe("brush");
    expect(session().resetTool()).toBe(false);
    // Undo in paint mode leaves the marks alone.
    session().addMark(box);
    session().setMode("paint");
    session().undo();
    expect(session().marks).toEqual([box]);
  });
});

describe("a sketch edit's body", () => {
  test("marks go to a model that reads them, with the mask only when the rest is kept", () => {
    const model = sketcher;
    const resolved = resolveValues(model.capabilities, {}, 1);
    const base = { assetId: "img", width: 1152, height: 1536 };
    const marks = marksForApi([
      { kind: "box", from: { x: 0.5, y: 0.5 }, to: { x: 0.2, y: 0.1 }, color: "#C8102E" },
    ]);
    const loose = editBody(model, resolved, " amber ", "k1", { base, marks });
    expect(loose.op).toBe("edit");
    expect(loose.mask).toBeUndefined();
    expect(loose.marks).toEqual([
      { kind: "box", from: { x: 0.2, y: 0.1 }, to: { x: 0.5, y: 0.5 }, color: "#C8102E" },
    ]);
    const kept = editBody(model, resolved, "amber", "k2", {
      base,
      marks,
      mask: { assetId: "mask", composite: true, featherPx: 8, expandPx: 4 },
    });
    expect(kept.op).toBe("inpaint");
    expect(kept.mask).toEqual({ assetId: "mask", composite: true, featherPx: 8, expandPx: 4 });
    expect(kept.marks).toHaveLength(1);
  });
});
