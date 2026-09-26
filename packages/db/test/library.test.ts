import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newId } from "@openfield/core";
import { CANVAS_SCHEMA } from "@openfield/core/canvas";
import {
  addAssetsToFolder,
  addFolder,
  assetNeighbours,
  countLibrary,
  deleteFolder,
  deleteFolderTree,
  emptyTrash,
  folderMemberships,
  folderSubtree,
  foldersOfAssetWithCounts,
  getCanvas,
  getFolder,
  InvalidCursorError,
  insertAsset,
  insertCanvas,
  type LibraryFilter,
  libraryCounts,
  libraryFacets,
  libraryPage,
  listFolders,
  type OpenDb,
  openDb,
  patchFolder,
  purgeAssets,
  removeAssetsFromFolder,
  restoreAssets,
  setCanvasFolder,
  setFavourites,
  softDeleteAssets,
  wouldNestInside,
} from "../src";

// The Assets library (§0.7, §2.8, §8.2.2): folders as a tree of labels with direct counts, moves
// that refuse loops, deletes that take subfolders but never images, many-to-many filing, the
// Trash that keeps folders and favourites, and every view on the shared cursor.

let opened: OpenDb;
const db = () => opened.db;
beforeEach(() => {
  opened = openDb(":memory:");
});
afterEach(() => opened.close());

const minute = (n: number) => new Date(Date.UTC(2026, 8, 24, 10, n)).toISOString();

interface ImageOpts {
  at?: number;
  prompt?: string;
  kind?: "generated" | "uploaded" | "mask";
  model?: string;
  provider?: string;
  path?: string;
  sha?: string;
  bytes?: number;
}

/** An image made `at` minutes past ten; ids sort in the same order as the times. */
function image(id: string, o: ImageOpts = {}) {
  return insertAsset(db(), {
    id,
    kind: o.kind ?? "generated",
    path: o.path ?? `assets/${id}.png`,
    mime: "image/png",
    width: 1,
    height: 1,
    bytes: o.bytes ?? 10,
    sha256: (o.sha ?? id.toLowerCase().padEnd(64, "0")).slice(0, 64),
    providerId: o.provider ?? "openai",
    modelId: o.model ?? "gpt-image",
    prompt: o.prompt ?? "",
    createdAt: minute(o.at ?? 0),
  });
}

function folder(name: string, parentId?: string) {
  const result = addFolder(db(), { id: newId(), name, parentId });
  if (!result.ok) throw new Error(result.reason);
  return result.folder;
}

const ids = (page: { items: { id: string }[] }) => page.items.map((a) => a.id);
const byName = () => new Map(listFolders(db()).map((f) => [f.name, f]));

/** Every page of a view, following the cursor. */
function allPages(q: LibraryFilter, limit = 2): { ids: string[]; pages: number; total?: number } {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total: number | undefined;
  do {
    const page = libraryPage(db(), { ...q, cursor, limit });
    if (pages === 0) total = page.total;
    else expect(page.total).toBeUndefined();
    seen.push(...ids(page));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  return { ids: seen, pages, total };
}

describe("folder tree", () => {
  test("counts are the live images filed directly inside, and subfolders are counted apart", () => {
    const clients = folder("Clients");
    const acme = folder("Acme", clients.id);
    const spring = folder("Spring 2026", acme.id);
    for (const [i, id] of ["A1", "A2", "A3", "A4"].entries()) image(id, { at: i });
    image("M1", { kind: "mask" });
    addAssetsToFolder(db(), clients.id, ["A1"]);
    addAssetsToFolder(db(), acme.id, ["A2", "A3", "A4", "M1"]);
    addAssetsToFolder(db(), spring.id, ["A4"]);
    softDeleteAssets(db(), ["A3"]);

    const f = byName();
    expect([f.get("Clients")?.count, f.get("Clients")?.childCount]).toEqual([1, 1]);
    // A3 is in the Trash and M1 is a mask: neither counts. A4 counts in both folders it's in.
    expect([f.get("Acme")?.count, f.get("Acme")?.childCount]).toEqual([2, 1]);
    expect([f.get("Spring 2026")?.count, f.get("Spring 2026")?.childCount]).toEqual([1, 0]);
    // Opening a folder lists exactly what it counts.
    expect(ids(libraryPage(db(), { folderId: acme.id }))).toEqual(["A4", "A2"]);
    expect(libraryPage(db(), { folderId: acme.id }).total).toBe(2);
  });

  test("a new folder goes at the top level or inside another, and needs a real parent", () => {
    const clients = folder("clients");
    folder("Brand");
    folder("acme", clients.id);
    expect(listFolders(db()).map((f) => f.name)).toEqual(["acme", "Brand", "clients"]); // case ignored
    expect(getFolder(db(), clients.id)?.childCount).toBe(1);
    expect(addFolder(db(), { id: newId(), name: "Lost", parentId: newId() })).toEqual({
      ok: false,
      reason: "parent_not_found",
    });
    expect(listFolders(db())).toHaveLength(3);
  });

  test("rename and move, to the top level and under another folder", () => {
    const clients = folder("Clients");
    const acme = folder("Acme", clients.id);
    const moodboard = folder("Moodboard");
    const renamed = patchFolder(db(), acme.id, { name: "Acme Inc" });
    expect(renamed.ok && renamed.folder.name).toBe("Acme Inc");
    expect(renamed.ok && renamed.folder.parentId).toBe(clients.id); // a rename doesn't move it

    const top = patchFolder(db(), acme.id, { parentId: null });
    expect(top.ok && top.folder.parentId).toBeNull();
    const under = patchFolder(db(), acme.id, { parentId: moodboard.id, name: "Acme" });
    expect(under.ok && [under.folder.parentId, under.folder.name]).toEqual([moodboard.id, "Acme"]);
    expect(getFolder(db(), moodboard.id)?.childCount).toBe(1);
    expect(getFolder(db(), clients.id)?.childCount).toBe(0);
  });

  test("a move into the folder itself or anything inside it is refused, and nothing changes", () => {
    const chain = [folder("Level 0")];
    for (let depth = 1; depth <= 5; depth++) chain.push(folder(`Level ${depth}`, chain[depth - 1]!.id));
    const root = chain[0]!;
    const before = getFolder(db(), root.id);

    expect(patchFolder(db(), root.id, { parentId: root.id })).toEqual({ ok: false, reason: "cycle" });
    expect(patchFolder(db(), root.id, { parentId: chain[1]!.id })).toEqual({ ok: false, reason: "cycle" });
    expect(patchFolder(db(), root.id, { parentId: chain[5]!.id, name: "Renamed" })).toEqual({
      ok: false,
      reason: "cycle",
    });
    expect(patchFolder(db(), chain[2]!.id, { parentId: chain[4]!.id })).toEqual({
      ok: false,
      reason: "cycle",
    });
    // The refused call carried a rename too: none of it was written.
    expect(getFolder(db(), root.id)).toEqual(before);

    expect(wouldNestInside(db(), root.id, chain[5]!.id)).toBe(true);
    expect(wouldNestInside(db(), chain[5]!.id, root.id)).toBe(false);
    // Up the chain is fine: the deepest folder can go to the top, or under the root.
    const ok = patchFolder(db(), chain[5]!.id, { parentId: root.id });
    expect(ok.ok && ok.folder.parentId).toBe(root.id);
  });

  test("unknown folders and parents answer not found", () => {
    const acme = folder("Acme");
    expect(patchFolder(db(), newId(), { name: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(patchFolder(db(), acme.id, { parentId: newId() })).toEqual({
      ok: false,
      reason: "parent_not_found",
    });
  });

  test("nesting has no depth limit: 1200 levels list, refuse loops and delete in one go", () => {
    const chain = [folder("Level 0")];
    for (let depth = 1; depth < 1200; depth++) chain.push(folder(`Level ${depth}`, chain[depth - 1]!.id));
    const root = chain[0]!;
    const deepest = chain[chain.length - 1]!;
    image("D1");
    addAssetsToFolder(db(), deepest.id, ["D1"]);

    expect(listFolders(db())).toHaveLength(1200);
    expect(folderSubtree(db(), root.id).map((f) => f.id)).toEqual(chain.map((f) => f.id));
    expect(patchFolder(db(), root.id, { parentId: deepest.id })).toEqual({ ok: false, reason: "cycle" });

    // SQLite's own cascade stops at 1000 levels; the delete takes the tree apart bottom up.
    expect(deleteFolderTree(db(), root.id)).toEqual(chain.map((f) => f.id));
    expect(listFolders(db())).toEqual([]);
    expect(ids(libraryPage(db(), {}))).toEqual(["D1"]);
  });
});

describe("deleting folders", () => {
  test("takes every folder inside and their filing, never an image", () => {
    const clients = folder("Clients");
    const acme = folder("Acme", clients.id);
    const spring = folder("Spring 2026", acme.id);
    const bloom = folder("Bloom", clients.id);
    const moodboard = folder("Moodboard");
    image("I1", { at: 1 });
    image("I2", { at: 2 });
    addAssetsToFolder(db(), spring.id, ["I1", "I2"]);
    addAssetsToFolder(db(), moodboard.id, ["I1"]);

    const deleted = deleteFolderTree(db(), clients.id);
    // Parents before children.
    expect(deleted?.[0]).toBe(clients.id);
    expect(new Set(deleted)).toEqual(new Set([clients.id, acme.id, spring.id, bloom.id]));
    expect(deleted!.indexOf(acme.id)).toBeLessThan(deleted!.indexOf(spring.id));

    expect(listFolders(db()).map((f) => f.name)).toEqual(["Moodboard"]);
    expect(ids(libraryPage(db(), {}))).toEqual(["I2", "I1"]); // All images unchanged
    expect(ids(libraryPage(db(), { folderId: moodboard.id }))).toEqual(["I1"]); // still in Moodboard
    expect(folderMemberships(db(), ["I1", "I2"])).toEqual([{ folderId: moodboard.id, count: 1 }]);
    expect(deleteFolderTree(db(), clients.id)).toBeNull();
    expect(deleteFolder(db(), moodboard.id)).toBe(true);
    expect(deleteFolder(db(), moodboard.id)).toBe(false);
  });

  test("a canvas keeps filing into its folder after a rename or move, and lets go when it's deleted", () => {
    const id = newId();
    insertCanvas(db(), {
      id,
      name: "Spring shoot",
      graph: {
        schema: CANVAS_SCHEMA,
        id,
        name: "Spring shoot",
        createdAt: minute(0),
        updatedAt: minute(0),
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
        comments: [],
        meta: {},
      },
    });
    const canvasFolder = folder("Spring shoot");
    const clients = folder("Clients");
    setCanvasFolder(db(), id, canvasFolder.id);

    patchFolder(db(), canvasFolder.id, { name: "Spring shoot (final)", parentId: clients.id });
    expect(getCanvas(db(), id)?.folderId).toBe(canvasFolder.id);
    deleteFolderTree(db(), clients.id);
    expect(getCanvas(db(), id)?.folderId).toBeNull();
  });
});

describe("filing", () => {
  test("an image can be in many folders; adding keeps the others, removing takes out one", () => {
    const acme = folder("Acme");
    const moodboard = folder("Moodboard");
    for (const [i, id] of ["F1", "F2", "F3"].entries()) image(id, { at: i });

    expect(addAssetsToFolder(db(), acme.id, ["F1", "F2", "F3"])).toEqual(["F1", "F2", "F3"]);
    // A repeated id counts once; an image already in the folder is skipped.
    expect(addAssetsToFolder(db(), moodboard.id, ["F1", "F2", "F3", "F1"])?.sort()).toEqual([
      "F1",
      "F2",
      "F3",
    ]);
    expect(addAssetsToFolder(db(), acme.id, ["F1", "F2"])).toEqual([]);

    expect(removeAssetsFromFolder(db(), acme.id, ["F1", "F2", "F3"])?.sort()).toEqual(["F1", "F2", "F3"]);
    expect(removeAssetsFromFolder(db(), acme.id, ["F1"])).toEqual([]);
    expect(ids(libraryPage(db(), { folderId: moodboard.id }))).toEqual(["F3", "F2", "F1"]);
    expect(byName().get("Acme")?.count).toBe(0);
    expect(byName().get("Moodboard")?.count).toBe(3);

    expect(addAssetsToFolder(db(), newId(), ["F1"])).toBeNull();
    expect(removeAssetsFromFolder(db(), newId(), ["F1"])).toBeNull();
  });

  test("images in the Trash aren't filed", () => {
    const acme = folder("Acme");
    image("T1");
    image("T2", { at: 1 });
    softDeleteAssets(db(), ["T2"]);
    expect(addAssetsToFolder(db(), acme.id, ["T1", "T2", "NOPE"])).toEqual(["T1"]);
  });

  test("memberships say on, mixed or off for the picker", () => {
    const acme = folder("Acme");
    const moodboard = folder("Moodboard");
    folder("Empty");
    for (const id of ["P1", "P2", "P3"]) image(id);
    addAssetsToFolder(db(), acme.id, ["P1", "P2", "P3"]);
    addAssetsToFolder(db(), moodboard.id, ["P2"]);
    const counts = new Map(folderMemberships(db(), ["P1", "P2", "P3"]).map((m) => [m.folderId, m.count]));
    expect(counts).toEqual(
      new Map([
        [acme.id, 3],
        [moodboard.id, 1],
      ]),
    );
  });

  test("the detail view lists the folders an image is in, with their counts", () => {
    const acme = folder("Acme");
    const clients = folder("Clients");
    folder("Other");
    image("X1");
    image("X2", { at: 1 });
    addAssetsToFolder(db(), acme.id, ["X1", "X2"]);
    addAssetsToFolder(db(), clients.id, ["X1"]);
    expect(foldersOfAssetWithCounts(db(), "X1").map((f) => [f.name, f.count])).toEqual([
      ["Acme", 2],
      ["Clients", 1],
    ]);
  });
});

describe("favourites", () => {
  test("bulk favourite and unfavourite say what changed, and skip the Trash", () => {
    for (const [i, id] of ["V1", "V2", "V3"].entries()) image(id, { at: i });
    softDeleteAssets(db(), ["V3"]);
    expect(setFavourites(db(), ["V1", "V2", "V3"], true).sort()).toEqual(["V1", "V2"]);
    expect(setFavourites(db(), ["V1", "V2"], true)).toEqual([]);
    expect(ids(libraryPage(db(), { favouritesOnly: true }))).toEqual(["V2", "V1"]);
    expect(libraryPage(db(), {}).items.find((a) => a.id === "V1")?.isFavourite).toBe(true);
    expect(setFavourites(db(), ["V1"], false)).toEqual(["V1"]);
    expect(setFavourites(db(), ["V1"], false)).toEqual([]);
    expect(libraryCounts(db()).favourites).toBe(1);
  });
});

describe("trash", () => {
  test("deleting keeps folders and favourites, so restoring puts the image back where it was", () => {
    const acme = folder("Acme");
    const moodboard = folder("Moodboard");
    image("R1", { at: 1 });
    image("R2", { at: 2 });
    addAssetsToFolder(db(), acme.id, ["R1", "R2"]);
    addAssetsToFolder(db(), moodboard.id, ["R1"]);
    setFavourites(db(), ["R1"], true);

    softDeleteAssets(db(), ["R1"]);
    expect(libraryCounts(db())).toEqual({ all: 1, favourites: 0, trash: 1 });
    expect([byName().get("Acme")?.count, byName().get("Moodboard")?.count]).toEqual([1, 0]);
    expect(ids(libraryPage(db(), { favouritesOnly: true }))).toEqual([]);
    // The Trash's detail view can still say where it will go back to.
    expect(foldersOfAssetWithCounts(db(), "R1").map((f) => f.name)).toEqual(["Acme", "Moodboard"]);

    expect(restoreAssets(db(), ["R1", "R2"])).toEqual(["R1"]);
    expect(libraryCounts(db())).toEqual({ all: 2, favourites: 1, trash: 0 });
    expect([byName().get("Acme")?.count, byName().get("Moodboard")?.count]).toEqual([2, 1]);
    expect(ids(libraryPage(db(), { favouritesOnly: true }))).toEqual(["R1"]);
  });

  test("the Trash lists newest deletion first on its own cursor, whatever the created order", () => {
    for (let i = 0; i < 5; i++) image(`T${i}`, { at: i });
    softDeleteAssets(db(), ["T4"], minute(20));
    softDeleteAssets(db(), ["T0", "T2"], minute(30)); // same moment: the id breaks the tie
    softDeleteAssets(db(), ["T1"], minute(40));

    const trash = allPages({ trash: true }, 2);
    expect(trash.ids).toEqual(["T1", "T2", "T0", "T4"]);
    expect(trash.total).toBe(4);
    expect(trash.pages).toBe(2);
    expect(libraryPage(db(), { trash: true }).items[0]?.deletedAt).toBe(minute(40));
    // The Trash ignores words, folders and filters.
    expect(ids(libraryPage(db(), { trash: true, text: "nothing", modelId: "other" }))).toEqual(trash.ids);
  });

  test("delete for good removes only trashed rows, and a file another image uses stays", () => {
    const acme = folder("Acme");
    // D1 and D2 share one file (an upload of a generated image's bytes); D3 has its own.
    image("D1", { path: "assets/shared.png", sha: "a".repeat(64), bytes: 100 });
    image("D2", { path: "assets/shared.png", sha: "a".repeat(64), bytes: 100, kind: "uploaded", at: 1 });
    image("D3", { path: "assets/own.png", sha: "b".repeat(64), bytes: 40, at: 2 });
    addAssetsToFolder(db(), acme.id, ["D1", "D3"]);
    setFavourites(db(), ["D1"], true);

    // Not in the Trash yet: nothing happens.
    expect(purgeAssets(db(), ["D1", "D3"]).deleted).toEqual([]);

    softDeleteAssets(db(), ["D1", "D3"]);
    const first = purgeAssets(db(), ["D1", "D3"]);
    expect(first.deleted.map((r) => r.id).sort()).toEqual(["D1", "D3"]);
    expect(first.files).toEqual(["assets/own.png"]); // D2 still uses the shared file
    expect(first.hashes).toEqual(["b".repeat(64)]);
    expect(first.reclaimedBytes).toBe(40);
    expect(folderMemberships(db(), ["D1", "D3"])).toEqual([]);

    // A live delete for good (?hard=1) takes the last copy with it.
    const last = purgeAssets(db(), ["D2"], { includeLive: true });
    expect(last).toMatchObject({
      files: ["assets/shared.png"],
      hashes: ["a".repeat(64)],
      reclaimedBytes: 100,
    });
    expect(libraryCounts(db())).toEqual({ all: 0, favourites: 0, trash: 0 });
  });

  test("a trashed copy keeps its file while a live copy uses it, and empty trash takes every trashed row", () => {
    image("E1", { path: "assets/e.png", sha: "c".repeat(64), bytes: 7 });
    image("E2", { path: "assets/e.png", sha: "c".repeat(64), bytes: 7, at: 1 });
    image("E3", { path: "assets/f.png", sha: "d".repeat(64), bytes: 5, at: 2 });
    softDeleteAssets(db(), ["E1", "E3"]);
    const result = emptyTrash(db());
    expect(result.deleted.map((r) => r.id).sort()).toEqual(["E1", "E3"]);
    expect(result.files).toEqual(["assets/f.png"]);
    expect(result.reclaimedBytes).toBe(5);
    expect(libraryCounts(db())).toEqual({ all: 1, favourites: 0, trash: 0 });
    expect(emptyTrash(db())).toEqual({ deleted: [], files: [], hashes: [], reclaimedBytes: 0 });
  });

  test("deleting for good removes the search row too", () => {
    image("S1", { prompt: "neon city at night" });
    softDeleteAssets(db(), ["S1"]);
    const fts = () => (db().$client.query("SELECT count(*) AS n FROM assets_fts").get() as { n: number }).n;
    expect(fts()).toBe(1);
    purgeAssets(db(), ["S1"]);
    expect(fts()).toBe(0);
  });
});

describe("views, search and filters", () => {
  test("masks are never listed or counted", () => {
    image("L1");
    image("L2", { kind: "mask", at: 1 });
    expect(ids(libraryPage(db(), {}))).toEqual(["L1"]);
    expect(ids(libraryPage(db(), { kind: "mask" }))).toEqual([]);
    expect(libraryCounts(db()).all).toBe(1);
  });

  test("search takes the folder, model, company and date filters, pages on the shared cursor, and counts", () => {
    const acme = folder("Acme");
    const other = folder("Other");
    const specs: [string, ImageOpts][] = [
      ["N0", { at: 0, prompt: "neon sign in the rain" }],
      ["N1", { at: 1, prompt: "neon alley", model: "nano-banana", provider: "google" }],
      ["N2", { at: 2, prompt: "neon diner at dusk" }],
      ["N3", { at: 3, prompt: "a quiet lake" }],
      ["N4", { at: 4, prompt: "neon street market" }],
      ["N5", { at: 5, prompt: "neon arcade" }],
      ["N6", { at: 6, prompt: "neon bar" }],
    ];
    for (const [id, o] of specs) image(id, o);
    addAssetsToFolder(db(), acme.id, ["N0", "N1", "N2", "N3", "N4", "N6"]);
    addAssetsToFolder(db(), other.id, ["N5"]);

    // Words, the folder (direct members only), a model and a company, from minute 1 on.
    const q: LibraryFilter = {
      text: "neon",
      folderId: acme.id,
      modelId: "gpt-image",
      providerId: "openai",
      from: minute(1),
    };
    const result = allPages(q, 2);
    expect(result.ids).toEqual(["N6", "N4", "N2"]);
    expect(result.total).toBe(3);
    expect(result.pages).toBe(2);
    expect(countLibrary(db(), q)).toBe(3);

    expect(ids(libraryPage(db(), { text: "neon", providerId: "google" }))).toEqual(["N1"]);
    expect(ids(libraryPage(db(), { text: "neo" }))).toEqual(["N6", "N5", "N4", "N2", "N1", "N0"]); // prefix
    expect(ids(libraryPage(db(), { from: minute(5) }))).toEqual(["N6", "N5"]);
    expect(ids(libraryPage(db(), { to: minute(1) }))).toEqual(["N0"]);
    // Nothing searchable in the words matches nothing, rather than everything.
    expect(libraryPage(db(), { text: '"*' })).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(ids(libraryPage(db(), { text: "   " }))).toHaveLength(7);
  });

  test("a cursor we didn't mint is refused", () => {
    expect(() => libraryPage(db(), { cursor: "not-a-cursor" })).toThrow(InvalidCursorError);
  });

  test("neighbours step through the view the detail view was opened from", () => {
    const acme = folder("Acme");
    for (let i = 0; i < 6; i++) image(`G${i}`, { at: i, prompt: i % 2 ? "neon" : "lake" });
    addAssetsToFolder(db(), acme.id, ["G1", "G2", "G4"]);
    const around = (q: LibraryFilter, id: string) => {
      const n = assetNeighbours(db(), q, id);
      return n && [n.previous?.id ?? null, n.next?.id ?? null];
    };

    expect(around({ folderId: acme.id }, "G2")).toEqual(["G4", "G1"]);
    expect(around({ folderId: acme.id }, "G4")).toEqual([null, "G2"]);
    expect(around({ folderId: acme.id }, "G1")).toEqual(["G2", null]);
    expect(around({ text: "neon" }, "G3")).toEqual(["G5", "G1"]);
    // Taken out of the folder, it still knows where it sat.
    removeAssetsFromFolder(db(), acme.id, ["G2"]);
    expect(around({ folderId: acme.id }, "G2")).toEqual(["G4", "G1"]);
    expect(assetNeighbours(db(), {}, "NOPE")).toBeUndefined();

    softDeleteAssets(db(), ["G0"], minute(30));
    softDeleteAssets(db(), ["G5"], minute(31));
    expect(around({ trash: true }, "G0")).toEqual(["G5", null]);
    expect(around({ trash: true }, "G3")).toEqual([null, null]); // not in the Trash
  });

  test("facets list what made a live image, for the filters", () => {
    image("C1", { model: "gpt-image", provider: "openai" });
    image("C2", { model: "gpt-image", provider: "openai", at: 1 });
    image("C3", { model: "nano-banana", provider: "google", at: 2 });
    image("C4", { model: "old-model", provider: "google", at: 3 });
    softDeleteAssets(db(), ["C4"]);
    expect(libraryFacets(db())).toEqual({
      models: [
        { providerId: "google", modelId: "nano-banana", count: 1 },
        { providerId: "openai", modelId: "gpt-image", count: 2 },
      ],
      providers: [
        { providerId: "google", count: 1 },
        { providerId: "openai", count: 2 },
      ],
    });
  });
});
