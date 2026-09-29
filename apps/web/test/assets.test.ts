// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, describe, expect, test } from "bun:test";
import type { AssetListItem } from "@openfield/core";
import {
  cardSizeFor,
  columnsFor,
  computeLayout,
  moveIndex,
  positionOf,
  rangeBetween,
  rowTop,
  rungFor,
  treeIndent,
  visibleGroups,
} from "../src/assets/layout";
import { isFiltered, searchOf, viewOf } from "../src/assets/route";
import { groupState, useSelection } from "../src/assets/selection";

const item = (id: string, extra: Partial<AssetListItem> = {}): AssetListItem => ({
  id,
  kind: "generated",
  jobSetId: null,
  jobId: null,
  modality: "image",
  width: 1024,
  height: 1024,
  mime: "image/png",
  sha256: "a".repeat(64),
  providerId: "google",
  modelId: "gemini-3.1-flash-lite-image",
  prompt: "",
  approximate: false,
  isFavourite: false,
  rerun: false,
  createdAt: "2026-09-24T10:00:00.000Z",
  thumbUrl: `/files/thumb/${id}`,
  fileUrl: `/files/assets/${id}`,
  ...extra,
});

describe("library grid geometry", () => {
  test("6 columns of 174px cards at the 1134px content width of a 1440 window (AC-2.8.1)", () => {
    expect(columnsFor(2)).toBe(6);
    expect(cardSizeFor(1134, 6)).toBe(174);
  });

  test("zoom steps 0 to 4 give 8 to 4 columns, and out-of-range steps clamp", () => {
    expect([0, 1, 2, 3, 4].map(columnsFor)).toEqual([8, 7, 6, 5, 4]);
    expect(columnsFor(-3)).toBe(8);
    expect(columnsFor(9)).toBe(4);
  });

  test("subfolder cards come first, then day groups 20 apart, as in design s5XLm", () => {
    const layout = computeLayout({
      width: 1134,
      columns: 6,
      groups: [
        { key: "folders", kind: "folders", count: 2 },
        { key: "2026-09-24", kind: "day", count: 4 },
        { key: "2026-09-21", kind: "day", count: 8 },
      ],
    });
    const [folders, today, older] = layout.groups;
    // Section title 40, gap 8, one row of 64.
    expect(folders).toMatchObject({ top: 0, height: 112, rows: 1 });
    expect(today).toMatchObject({ top: 132, height: 222, rows: 1, start: 0 });
    // Two rows of 174 with 18 between them.
    expect(older).toMatchObject({ top: 374, height: 414, rows: 2, start: 4 });
    expect(rowTop(older!, 1)).toBe(40 + 8 + 174 + 18);
    expect(layout.height).toBe(374 + 414);
  });

  test("only the groups and rows near the viewport render", () => {
    const layout = computeLayout({
      width: 1134,
      columns: 6,
      groups: Array.from({ length: 50 }, (_, i) => ({ key: `d${i}`, kind: "day" as const, count: 60 })),
    });
    const shown = visibleGroups(layout, 20_000, 800, 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(4);
    for (const { group, firstRow, lastRow } of shown) {
      expect(firstRow).toBeGreaterThanOrEqual(0);
      expect(lastRow).toBeLessThan(group.rows);
      expect(lastRow - firstRow).toBeLessThan(8);
    }
  });

  test("arrow keys walk the cards across day groups and keep the column", () => {
    const layout = computeLayout({
      width: 1134,
      columns: 6,
      groups: [
        { key: "a", kind: "day", count: 8 },
        { key: "b", kind: "day", count: 3 },
      ],
    });
    // Card 1 is in the first row; down goes to card 7 in the second row.
    expect(moveIndex(layout, 1, "ArrowDown", 11)).toBe(7);
    // Card 4 has nothing below it in the short second row: it lands on that row's last card.
    expect(moveIndex(layout, 4, "ArrowDown", 11)).toBe(7);
    // From the second row down into the next group, same column when it exists.
    expect(moveIndex(layout, 6, "ArrowDown", 11)).toBe(8);
    expect(moveIndex(layout, 8, "ArrowUp", 11)).toBe(6);
    expect(moveIndex(layout, 7, "ArrowRight", 11)).toBe(8);
    expect(moveIndex(layout, 0, "ArrowLeft", 11)).toBe(0);
    expect(moveIndex(layout, 3, "End", 11)).toBe(10);
    expect(positionOf(layout, 9)).toMatchObject({ row: 0, col: 1 });
  });

  test("a range is every loaded card between two, in order, either way round", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "a", "zz")).toEqual([]);
  });

  test("cards ask for the smallest thumbnail rung that still covers them", () => {
    expect(rungFor(174, 1024, 1024)).toBe(200);
    // A 3:4 portrait covers a 174 square at 232 tall.
    expect(rungFor(174, 768, 1024)).toBe(280);
    expect(rungFor(2000, 1024, 1024)).toBe(640);
  });

  test("the tree indents 4, then 20 more per level (design ifcYq)", () => {
    expect([0, 1, 2, 3].map(treeIndent)).toEqual([4, 24, 44, 64]);
  });
});

describe("library selection", () => {
  beforeEach(() => useSelection.getState().clear());

  test("toggle, set and drop keep ids and copies together, and move the anchor", () => {
    const { toggle, set, drop } = useSelection.getState();
    toggle(item("a"));
    set([item("b"), item("c")], true, "c");
    expect([...useSelection.getState().ids]).toEqual(["a", "b", "c"]);
    expect(useSelection.getState().anchor).toBe("c");
    drop(["c"]);
    expect(useSelection.getState().ids.has("c")).toBe(false);
    expect(useSelection.getState().items.has("c")).toBe(false);
    expect(useSelection.getState().anchor).toBeNull();
    toggle(item("a"));
    expect([...useSelection.getState().ids]).toEqual(["b"]);
  });

  test("refresh swaps in newer copies of selected images only", () => {
    useSelection.getState().toggle(item("a"));
    useSelection.getState().refresh([item("a", { isFavourite: true }), item("z")]);
    expect(useSelection.getState().items.get("a")?.isFavourite).toBe(true);
    expect(useSelection.getState().items.has("z")).toBe(false);
  });

  test("a date group's checkbox is off, mixed or on", () => {
    const day = [item("a"), item("b")];
    expect(groupState(new Set(), day)).toBe(false);
    expect(groupState(new Set(["a"]), day)).toBe("indeterminate");
    expect(groupState(new Set(["a", "b", "x"]), day)).toBe(true);
  });
});

describe("library routes", () => {
  test("each path names its view", () => {
    expect(viewOf("/assets")).toBe("all");
    expect(viewOf("/assets/favourites")).toBe("favourites");
    expect(viewOf("/assets/trash")).toBe("trash");
    expect(viewOf("/assets/folder/01K000000000000000000000AB")).toBe("folder");
  });

  test("words and filters travel between views without the view itself", () => {
    const query = {
      view: "folder" as const,
      folderId: "01K000000000000000000000AB",
      q: "neon",
      date: "7d" as const,
    };
    expect(searchOf(query)).toEqual({ q: "neon", date: "7d" });
    expect(isFiltered(query)).toBe(true);
    expect(isFiltered({ view: "all" })).toBe(false);
  });
});
