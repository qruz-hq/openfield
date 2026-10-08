// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
import { dropIndex, makeRoomOffset, referenceLimit, referenceNote } from "../src/image/composer/references";
import { useComposer } from "../src/image/composer/store";
import { banana } from "./fixtures";

const withMax = (max: number): ModelListItem => ({
  ...banana,
  capabilities: {
    ...banana.capabilities,
    references: { ...banana.capabilities.references, supported: max > 0, max },
  },
});

describe("the composer's references", () => {
  beforeEach(() => useComposer.setState({ references: [] }));

  test("addReferences keeps order and skips ones already there", () => {
    useComposer.getState().addReference("a");
    useComposer.getState().addReferences(["b", "a", "c", "b"]);
    expect(useComposer.getState().references).toEqual(["a", "b", "c"]);
  });

  test("setReferences replaces them in the picker's order, once each", () => {
    useComposer.setState({ references: ["a", "b"] });
    useComposer.getState().setReferences(["c", "a", "c"]);
    expect(useComposer.getState().references).toEqual(["c", "a"]);
  });

  test("moveReference puts one at a position, clamped to the strip", () => {
    useComposer.setState({ references: ["a", "b", "c"] });
    useComposer.getState().moveReference("c", 0);
    expect(useComposer.getState().references).toEqual(["c", "a", "b"]);
    useComposer.getState().moveReference("c", 99);
    expect(useComposer.getState().references).toEqual(["a", "b", "c"]);
    useComposer.getState().moveReference("missing", 0);
    expect(useComposer.getState().references).toEqual(["a", "b", "c"]);
  });

  test("the limit is the picked model's, and no model holds nothing back", () => {
    expect(referenceLimit(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(referenceLimit(withMax(3))).toBe(3);
    expect(referenceLimit(withMax(0))).toBe(0);
  });

  test("the note says when some or all references won't be sent", () => {
    expect(referenceNote(withMax(3), 2)).toBeNull();
    expect(referenceNote(withMax(3), 0)).toBeNull();
    expect(referenceNote(undefined, 5)).toBeNull();
    expect(referenceNote(withMax(2), 3)).toBe(
      `2 of 3 references will be sent to ${banana.displayName}. Drag to choose which.`,
    );
    expect(referenceNote(withMax(0), 1)).toBe(`${banana.displayName} doesn't take reference images`);
  });

  test("a dragged tile lands on the nearest slot, within the row", () => {
    // 56 tiles 6 apart: a slot is 62.
    expect(dropIndex(0, 20, 3)).toBe(0);
    expect(dropIndex(0, 40, 3)).toBe(1);
    expect(dropIndex(0, 500, 3)).toBe(2);
    expect(dropIndex(2, -70, 3)).toBe(1);
    expect(dropIndex(1, -500, 3)).toBe(0);
  });

  test("the tiles it passes slide one slot the other way, and only those", () => {
    // Dragging the first to the third: the second and third slide left.
    expect([0, 1, 2, 3].map((i) => makeRoomOffset(i, 0, 2))).toEqual([0, -62, -62, 0]);
    // Dragging the fourth to the second: the second and third slide right.
    expect([0, 1, 2, 3].map((i) => makeRoomOffset(i, 3, 1))).toEqual([0, 62, 62, 0]);
    expect([0, 1, 2].map((i) => makeRoomOffset(i, 1, 1))).toEqual([0, 0, 0]);
  });
});
