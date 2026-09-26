// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  buildFolderTree,
  dayHeading,
  type Folder,
  folderDescendants,
  folderPath,
  groupByDay,
  hasLibraryFilters,
  libraryDateFrom,
  libraryHref,
  libraryListParams,
  localDayKey,
  matchFolders,
  moveTarget,
  parseLibraryUrl,
  setFormatLocale,
  visibleFolders,
} from "../src";

// The library's shared logic (§2.8): the tree the sidebar, picker and Move to menu draw, the
// query each view sends, the Date filter and date groups.

beforeAll(() => setFormatLocale("en-US"));

let seq = 0;
function folder(name: string, parentId: string | null = null, count = 0): Folder {
  seq++;
  return {
    id: `01K6BQ7Y2M8N4P0R3S5T7V${String(seq).padStart(4, "0")}`,
    name,
    color: null,
    parentId,
    sortOrder: 0,
    count,
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
  };
}

/** Clients › Acme › Spring 2026, Clients › Bloom, Shoot 10, shoot 2. */
function sample() {
  const clients = folder("Clients", null, 1);
  const acme = folder("Acme", clients.id, 8);
  const spring = folder("Spring 2026", acme.id, 3);
  const bloom = folder("Bloom", clients.id);
  const shoot10 = folder("Shoot 10");
  const shoot2 = folder("shoot 2");
  const list = [spring, shoot10, bloom, clients, shoot2, acme];
  return { clients, acme, spring, bloom, shoot10, shoot2, tree: buildFolderTree(list) };
}

const names = (nodes: { folder: Folder }[]) => nodes.map((n) => n.folder.name);

describe("folder tree", () => {
  test("nests by parentId with depth, direct child counts and the sidebar's order", () => {
    const { tree, acme, clients } = sample();
    expect(names(tree.roots)).toEqual(["Clients", "shoot 2", "Shoot 10"]); // numeric, case ignored
    const acmeNode = tree.byId.get(acme.id)!;
    expect([acmeNode.depth, acmeNode.childCount, acmeNode.folder.count]).toEqual([1, 1, 8]);
    expect(tree.byId.get(clients.id)?.childCount).toBe(2);
    expect(names(visibleFolders(tree))).toEqual([
      "Clients",
      "Acme",
      "Spring 2026",
      "Bloom",
      "shoot 2",
      "Shoot 10",
    ]);
    // Collapsed folders hide what's inside.
    expect(names(visibleFolders(tree, (id) => id === clients.id))).toEqual([
      "Clients",
      "Acme",
      "Bloom",
      "shoot 2",
      "Shoot 10",
    ]);
  });

  test("the breadcrumb runs from the top level down", () => {
    const { tree, spring } = sample();
    expect(names(folderPath(tree, spring.id))).toEqual(["Clients", "Acme", "Spring 2026"]);
    expect(folderPath(tree, "missing")).toEqual([]);
  });

  test("descendants go any depth down", () => {
    const { tree, clients } = sample();
    expect(names(folderDescendants(tree.byId.get(clients.id)!)).sort()).toEqual([
      "Acme",
      "Bloom",
      "Spring 2026",
    ]);
  });

  test("Move to refuses the folder and its subtree and marks where it already is", () => {
    const { tree, clients, acme, spring, bloom, shoot2 } = sample();
    expect(moveTarget(tree, clients.id, clients.id)).toBe("inside");
    expect(moveTarget(tree, clients.id, spring.id)).toBe("inside");
    expect(moveTarget(tree, clients.id, null)).toBe("current");
    expect(moveTarget(tree, acme.id, clients.id)).toBe("current");
    expect(moveTarget(tree, acme.id, bloom.id)).toBe("allowed");
    expect(moveTarget(tree, acme.id, null)).toBe("allowed");
    expect(moveTarget(tree, spring.id, shoot2.id)).toBe("allowed");
  });

  test("a missing parent or a loop in the data never hides a folder", () => {
    const orphan = folder("Orphan", "01K6BQ7Y2M8N4P0R3S5T7VZZZZ");
    const a = folder("Loop A");
    const b = folder("Loop B", a.id);
    a.parentId = b.id;
    const tree = buildFolderTree([orphan, a, b]);
    expect(visibleFolders(tree)).toHaveLength(3);
    expect(tree.byId.get(orphan.id)?.depth).toBe(0);
  });

  test("a deep chain builds without a depth limit", () => {
    const chain = [folder("0")];
    for (let i = 1; i < 2000; i++) chain.push(folder(String(i), chain[i - 1]!.id));
    const tree = buildFolderTree(chain.slice().reverse());
    expect(tree.byId.get(chain[1999]!.id)?.depth).toBe(1999);
    expect(folderPath(tree, chain[1999]!.id)).toHaveLength(2000);
  });

  test("Find a folder keeps each match's ancestors", () => {
    const { tree, clients, acme, spring } = sample();
    expect(matchFolders(tree, "  ")).toBeNull();
    expect(matchFolders(tree, "SPRING")).toEqual(new Set([clients.id, acme.id, spring.id]));
    expect(matchFolders(tree, "zzz")).toEqual(new Set());
  });
});

describe("library views", () => {
  test("each view sends its own scope, and the Trash drops words and filters", () => {
    const now = new Date(2026, 8, 24, 15, 30);
    expect(libraryListParams({ view: "all" })).toEqual({});
    expect(libraryListParams({ view: "favourites", q: " neon " })).toEqual({ favourite: "1", q: "neon" });
    expect(
      libraryListParams({ view: "folder", folderId: "F", model: "openai:gpt-image-2", date: "today" }, now),
    ).toEqual({
      folder: "F",
      model: "gpt-image-2",
      provider: "openai",
      from: new Date(2026, 8, 24).toISOString(),
    });
    expect(libraryListParams({ view: "all", provider: "google" })).toEqual({ provider: "google" });
    expect(libraryListParams({ view: "trash", q: "neon", provider: "google" })).toEqual({ trash: "1" });
  });

  test("the URL round-trips, and values it can't carry are dropped", () => {
    const params = new URLSearchParams("q=neon&model=openai%3Agpt-image-2&date=7d&provider=BAD%20ID");
    const query = parseLibraryUrl("folder", params, "F1");
    expect(query).toEqual({
      view: "folder",
      folderId: "F1",
      q: "neon",
      model: "openai:gpt-image-2",
      date: "7d",
    });
    expect(libraryHref(query)).toBe("/assets/folder/F1?q=neon&model=openai%3Agpt-image-2&date=7d");
    expect(parseLibraryUrl("all", new URLSearchParams("date=yesterday&q="))).toEqual({ view: "all" });
    expect(parseLibraryUrl("trash", new URLSearchParams("q=neon"))).toEqual({ view: "trash" });
    expect(libraryHref({ view: "trash", q: "neon" })).toBe("/assets/trash");
    expect(libraryHref({ view: "favourites" })).toBe("/assets/favourites");
    expect(hasLibraryFilters({ view: "all", q: "neon" })).toBe(false);
    expect(hasLibraryFilters({ view: "all", date: "30d" })).toBe(true);
  });

  test("Date filters start at local midnight", () => {
    const now = new Date(2026, 8, 24, 15, 30);
    expect(libraryDateFrom("today", now)).toBe(new Date(2026, 8, 24).toISOString());
    expect(libraryDateFrom("7d", now)).toBe(new Date(2026, 8, 18).toISOString());
    expect(libraryDateFrom("30d", now)).toBe(new Date(2026, 7, 26).toISOString());
    expect(libraryDateFrom("12m", now)).toBe(new Date(2025, 8, 24).toISOString());
  });
});

describe("date groups", () => {
  test("consecutive items on the same local day share a group", () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
    const items = [at(24, 18), at(24, 1), at(23, 12), at(21, 9), at(21, 8)];
    const groups = groupByDay(items, (v) => v);
    expect(groups.map((g) => [g.day, g.items.length])).toEqual([
      ["2026-09-24", 2],
      ["2026-09-23", 1],
      ["2026-09-21", 2],
    ]);
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  test("headings read Today, Yesterday, then the date, with the year only when it differs", () => {
    const now = new Date(2026, 8, 24, 9);
    expect(dayHeading("2026-09-24", now)).toBe("Today");
    expect(dayHeading("2026-09-23", now)).toBe("Yesterday");
    expect(dayHeading("2026-09-21", now)).toBe("September 21");
    expect(dayHeading("2025-12-31", now)).toBe("December 31, 2025");
  });
});
