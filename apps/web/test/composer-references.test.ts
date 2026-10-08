// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
import { referenceLimit, referenceNote } from "../src/image/composer/references";
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
});
