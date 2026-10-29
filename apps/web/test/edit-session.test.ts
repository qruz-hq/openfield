// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterEach, describe, expect, test } from "bun:test";
import { editKey } from "../src/detail/edit/keys";
import { type LassoStep, lassoDoubleClick, lassoDown, lassoMove, lassoUp } from "../src/detail/edit/lasso";
import type { Point, Rect } from "../src/detail/edit/mask";
import {
  cancelLeave,
  confirmLeave,
  defaultBrushSize,
  editHasWork,
  leaveEdit,
  sizeOfSlider,
  sliderOfSize,
  subscribeMask,
  useEditSession,
} from "../src/detail/edit/session";

// The Edit tab's session, keys and lasso, without a DOM: what the paint surface and the detail view
// lean on.

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  editKey({
    key: k,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  });

describe("keys on the Edit tab", () => {
  test("tool letters pick the tools", () => {
    expect(key("d")).toEqual({ kind: "tool", tool: "brush" });
    expect(key("E")).toEqual({ kind: "tool", tool: "eraser" });
    expect(key("a")).toEqual({ kind: "tool", tool: "lasso" });
    expect(key("m")).toEqual({ kind: "tool", tool: "rect" });
    expect(key("h")).toEqual({ kind: "tool", tool: "pan" });
  });

  test("undo and redo, with ⌘ or Ctrl", () => {
    expect(key("z", { meta: true })).toEqual({ kind: "undo" });
    expect(key("z", { ctrl: true })).toEqual({ kind: "undo" });
    expect(key("Z", { meta: true, shift: true })).toEqual({ kind: "redo" });
    expect(key("z", { ctrl: true, shift: true })).toEqual({ kind: "redo" });
  });

  test("Download moves to ⇧⌘S, since D is the brush", () => {
    expect(key("s", { meta: true, shift: true })).toEqual({ kind: "download" });
    expect(key("S", { ctrl: true, shift: true })).toEqual({ kind: "download" });
    expect(key("s", { meta: true })).toBeNull();
  });

  test("the view's own letters, Delete and the arrows do nothing", () => {
    for (const k of ["f", "r", "u", "Delete", "Backspace", "ArrowLeft", "ArrowRight"]) {
      expect(key(k)).toEqual({ kind: "blocked" });
    }
    // Shifted letters too: ⇧F would expand, ⇧D mustn't download.
    expect(key("F", { shift: true })).toEqual({ kind: "blocked" });
    expect(key("D", { shift: true })).toEqual({ kind: "blocked" });
  });

  test("zoom, Esc, Tab and Space are left to the view", () => {
    for (const k of ["+", "=", "-", "_", "0", "Escape", "Tab", " "]) expect(key(k)).toBeNull();
    expect(key("d", { alt: true })).toBeNull();
  });
});

describe("the lasso", () => {
  const p = (x: number, y: number): Point => ({ x, y });
  /** One image px is one screen px. */
  const scale = 1;

  test("a drag that starts it draws it freehand and closes when the button comes up", () => {
    let step: LassoStep = lassoDown(null, p(10, 10), scale);
    for (const at of [p(40, 10), p(40, 40), p(10, 40)]) step = lassoMove(step.draft, at, scale);
    step = lassoUp(step.draft, p(12, 30), scale);
    expect(step.draft).toBeNull();
    expect(step.closed).toEqual([p(10, 10), p(40, 10), p(40, 40), p(10, 40), p(12, 30)]);
  });

  test("clicks place corners, the line follows the pointer, and a double-click closes it", () => {
    let step: LassoStep = { draft: null };
    for (const at of [p(10, 10), p(50, 10), p(50, 50)]) {
      step = lassoDown(step.draft, at, scale);
      step = lassoUp(step.draft, at, scale);
    }
    step = lassoMove(step.draft, p(20, 60), scale);
    expect(step.draft?.pointer).toEqual(p(20, 60));
    expect(step.draft?.corners).toEqual([0, 1, 2]);
    // The double-click's two presses land on one spot: one corner, then closed.
    step = lassoDown(step.draft, p(20, 60), scale);
    step = lassoUp(step.draft, p(20, 60), scale);
    step = lassoDown(step.draft, p(20, 60), scale);
    step = lassoUp(step.draft, p(20, 60), scale);
    expect(step.draft?.points).toHaveLength(4);
    step = lassoDoubleClick(step.draft);
    expect(step.closed).toEqual([p(10, 10), p(50, 10), p(50, 50), p(20, 60)]);
  });

  test("a click back on the first corner closes it", () => {
    let step: LassoStep = { draft: null };
    for (const at of [p(10, 10), p(50, 10), p(50, 50)]) {
      step = lassoDown(step.draft, at, scale);
      step = lassoUp(step.draft, at, scale);
    }
    step = lassoDown(step.draft, p(13, 12), scale);
    expect(step.closed).toEqual([p(10, 10), p(50, 10), p(50, 50)]);
  });

  test("closing with fewer than three corners paints nothing", () => {
    let step = lassoDown(null, p(10, 10), scale);
    step = lassoUp(step.draft, p(10, 10), scale);
    step = lassoDown(step.draft, p(40, 40), scale);
    step = lassoUp(step.draft, p(40, 40), scale);
    step = lassoDoubleClick(step.draft);
    expect(step).toEqual({ draft: null });
  });

  test("distances are screen px, so zooming out doesn't make every click a drag", () => {
    // Zoomed out to 25%: 12 image px is 3 screen px, still a click.
    let step = lassoDown(null, p(100, 100), 0.25);
    step = lassoMove(step.draft, p(112, 100), 0.25);
    step = lassoUp(step.draft, p(112, 100), 0.25);
    expect(step.draft?.press).toBeNull();
    expect(step.draft?.points).toEqual([p(100, 100)]);
  });
});

describe("the edit session", () => {
  afterEach(() => useEditSession.getState().end());

  test("starts a mask at the image's size, with the brush at 8% of its short side", () => {
    useEditSession.getState().start("a", 1152, 1536);
    const { editor, brushSize, mask, tool } = useEditSession.getState();
    expect(editor?.mask.width).toBe(1152);
    expect(editor?.mask.height).toBe(1536);
    expect(brushSize).toBe(92);
    expect(mask).toEqual({ empty: true, changes: false, canUndo: false, canRedo: false });
    expect(tool).toBe("brush");
    expect(defaultBrushSize(10_000, 8_000)).toBe(512);
    expect(defaultBrushSize(8, 8)).toBe(1);
  });

  test("keeps the edit open on the same image, and a new image starts afresh", () => {
    useEditSession.getState().start("a", 64, 64);
    const first = useEditSession.getState().editor;
    useEditSession.getState().setPrompt("pale berries");
    useEditSession.getState().start("a", 64, 64);
    expect(useEditSession.getState().editor).toBe(first);
    expect(useEditSession.getState().prompt).toBe("pale berries");
    useEditSession.getState().start("b", 64, 64);
    expect(useEditSession.getState().editor).not.toBe(first);
    expect(useEditSession.getState().prompt).toBe("");
  });

  test("tells the surface what changed, and keeps the toolbar's flags", () => {
    useEditSession.getState().start("a", 64, 64);
    const changed: (Rect | null)[] = [];
    const unsubscribe = subscribeMask((rect) => changed.push(rect));
    const { changeMask } = useEditSession.getState();
    changeMask((editor) =>
      editor.apply({ type: "rect", mode: "paint", from: { x: 4, y: 4 }, to: { x: 20, y: 12 } }),
    );
    expect(changed).toEqual([{ x: 4, y: 4, width: 16, height: 8 }]);
    expect(useEditSession.getState().mask).toEqual({
      empty: false,
      changes: true,
      canUndo: true,
      canRedo: false,
    });
    useEditSession.getState().undo();
    expect(useEditSession.getState().mask).toEqual({
      empty: true,
      changes: false,
      canUndo: false,
      canRedo: true,
    });
    useEditSession.getState().redo();
    useEditSession.getState().invert();
    expect(useEditSession.getState().editor?.mask.data[0]).toBe(255);
    useEditSession.getState().clear();
    expect(useEditSession.getState().mask.empty).toBe(true);
    expect(changed).toHaveLength(5);
    unsubscribe();
  });

  test("a stroke's flags wait for its end", () => {
    useEditSession.getState().start("a", 64, 64);
    const { changeMask } = useEditSession.getState();
    const brush = { mode: "paint", size: 8, hardness: 100 } as const;
    changeMask((editor) => editor.beginStroke(brush, { x: 10, y: 10 }));
    expect(useEditSession.getState().mask.empty).toBe(true);
    changeMask((editor) => editor.endStroke({ x: 30, y: 10 }));
    expect(useEditSession.getState().mask).toEqual({
      empty: false,
      changes: true,
      canUndo: true,
      canRedo: false,
    });
  });

  test("only a change to the pixels is a new mask, so the one saved for a run still goes by id", () => {
    useEditSession.getState().start("a", 64, 64);
    const session = () => useEditSession.getState();
    session().setSavedMask("mask-1", session().maskVersion);
    // Nothing to undo, redo or clear: the same mask.
    session().undo();
    session().redo();
    session().clear();
    expect(session().maskVersion).toBe(0);
    // A point with no stroke going, as after a tool switch mid-drag.
    session().changeMask((editor) => editor.strokeTo({ x: 5, y: 5 }));
    expect(session().maskVersion).toBe(0);
    expect(session().savedMask).toEqual({ assetId: "mask-1", version: 0 });
    session().changeMask((editor) =>
      editor.apply({ type: "rect", mode: "paint", from: { x: 4, y: 4 }, to: { x: 20, y: 12 } }),
    );
    expect(session().maskVersion).toBe(1);
    // The same box again changes no pixel.
    session().changeMask((editor) =>
      editor.apply({ type: "rect", mode: "paint", from: { x: 4, y: 4 }, to: { x: 20, y: 12 } }),
    );
    expect(session().maskVersion).toBe(1);
  });

  test("a faint edge left by the eraser is painted, but not enough to Generate", () => {
    useEditSession.getState().start("a", 200, 120);
    const { changeMask } = useEditSession.getState();
    const path = [
      { x: 40, y: 60 },
      { x: 160, y: 60 },
    ];
    changeMask((editor) =>
      editor.apply({ type: "stroke", brush: { mode: "paint", size: 92, hardness: 80 }, points: path }),
    );
    changeMask((editor) =>
      editor.apply({ type: "stroke", brush: { mode: "erase", size: 92, hardness: 80 }, points: path }),
    );
    expect(useEditSession.getState().mask).toMatchObject({ empty: false, changes: false });
    // Still something to lose by leaving, as it shows.
    expect(editHasWork()).toBe(true);
  });

  test("leaving asks only when a mask, a prompt or a reference would be lost", () => {
    let left = 0;
    const leave = () => left++;
    useEditSession.getState().start("a", 64, 64);
    leaveEdit(leave);
    expect(left).toBe(1);

    useEditSession.getState().setPrompt("pale berries");
    expect(editHasWork()).toBe(true);
    leaveEdit(leave);
    expect(left).toBe(1);
    expect(useEditSession.getState().leaving).not.toBeNull();
    cancelLeave();
    expect(useEditSession.getState().leaving).toBeNull();
    expect(useEditSession.getState().prompt).toBe("pale berries");

    leaveEdit(leave);
    confirmLeave();
    expect(left).toBe(2);
    expect(useEditSession.getState().assetId).toBeNull();
    expect(useEditSession.getState().prompt).toBe("");
  });

  test("hardness and the mask's strength outlast an edit", () => {
    useEditSession.getState().start("a", 64, 64);
    useEditSession.getState().setHardness(35);
    useEditSession.getState().setMaskOpacity(70);
    useEditSession.getState().end();
    useEditSession.getState().start("b", 64, 64);
    expect(useEditSession.getState().hardness).toBe(35);
    expect(useEditSession.getState().maskOpacity).toBe(70);
  });
});

describe("the brush size slider", () => {
  test("92 px sits at 42%, as the design draws it", () => {
    expect(sliderOfSize(92) / 1000).toBeCloseTo(0.42, 2);
  });

  test("runs from 1 to 512 and comes back to the size it was given", () => {
    expect(sizeOfSlider(0)).toBe(1);
    expect(sizeOfSlider(1000)).toBe(512);
    for (const size of [1, 2, 5, 12, 40, 92, 200, 511, 512])
      expect(sizeOfSlider(sliderOfSize(size))).toBe(size);
  });
});
