// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import {
  ALL_PLACE,
  FAVOURITES_PLACE,
  movePick,
  type Place,
  placeQuery,
  samePlace,
  togglePick,
} from "../src/canvas/nodes/assets/picker-order";

// The Assets node picker's pure logic (design q31cb): which place is open, what it asks the
// library for, and the picked list's order.

describe("places", () => {
  test("two places are the same only by kind, a folder also by id", () => {
    expect(samePlace(FAVOURITES_PLACE, FAVOURITES_PLACE)).toBe(true);
    expect(samePlace(FAVOURITES_PLACE, ALL_PLACE)).toBe(false);
    const a: Place = { kind: "folder", folderId: "f1" };
    const b: Place = { kind: "folder", folderId: "f1" };
    const c: Place = { kind: "folder", folderId: "f2" };
    expect(samePlace(a, b)).toBe(true);
    expect(samePlace(a, c)).toBe(false);
    expect(samePlace(a, ALL_PLACE)).toBe(false);
  });

  test("each place asks the library for its own view, search words along for the ride", () => {
    expect(placeQuery(FAVOURITES_PLACE, "cat")).toEqual({ view: "favourites", q: "cat" });
    expect(placeQuery(ALL_PLACE, "")).toEqual({ view: "all", q: "" });
    expect(placeQuery({ kind: "folder", folderId: "f1" }, "dog")).toEqual({
      view: "folder",
      folderId: "f1",
      q: "dog",
    });
  });
});

describe("picking", () => {
  test("picking again toggles: new joins at the end, picked already drops out, order kept", () => {
    let ids = togglePick([], "a");
    expect(ids).toEqual(["a"]);
    ids = togglePick(ids, "b");
    expect(ids).toEqual(["a", "b"]);
    ids = togglePick(ids, "a");
    expect(ids).toEqual(["b"]);
  });

  test("at the limit a new pick is turned away, and with a limit of 1 it swaps in", () => {
    expect(togglePick(["a", "b"], "c", 2)).toEqual(["a", "b"]);
    expect(togglePick(["a", "b"], "b", 2)).toEqual(["a"]);
    expect(togglePick(["a"], "b", 1)).toEqual(["b"]);
    expect(togglePick(["a"], "a", 1)).toEqual([]);
  });

  test("moving clamps to the list and does nothing for an id that isn't picked or a no-op move", () => {
    const ids = ["a", "b", "c"];
    expect(movePick(ids, "c", 0)).toEqual(["c", "a", "b"]);
    expect(movePick(ids, "a", 5)).toEqual(["b", "c", "a"]);
    expect(movePick(ids, "a", -5)).toEqual(["a", "b", "c"]);
    expect(movePick(ids, "b", 1)).toEqual(["a", "b", "c"]);
    expect(movePick(ids, "zzz", 0)).toEqual(["a", "b", "c"]);
    // Never mutates the list handed in.
    movePick(ids, "c", 0);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
