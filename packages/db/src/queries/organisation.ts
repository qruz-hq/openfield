import { and, asc, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { FolderRow, NewFolderRow } from "../rows";
import { assetFolders, assets, favourites, folders } from "../schema";
import { chunked, type Draft, nowIso } from "./_util";

// Favourites, folders and what's filed where (§0.7, §8.2.2). Folders are a tree of labels:
// parent_id nests them with no depth limit, and asset_folders lets an image sit in many.

// Favourites

export function setFavourite(db: Executor, assetIds: readonly string[], at = nowIso()): void {
  if (assetIds.length === 0) return;
  db.insert(favourites)
    .values(assetIds.map((assetId) => ({ assetId, createdAt: at })))
    .onConflictDoNothing()
    .run();
}

export function clearFavourite(db: Executor, assetIds: readonly string[]): void {
  if (assetIds.length === 0) return;
  db.delete(favourites)
    .where(inArray(favourites.assetId, [...assetIds]))
    .run();
}

export function isFavourite(db: Executor, assetId: string): boolean {
  return db.select().from(favourites).where(eq(favourites.assetId, assetId)).get() !== undefined;
}

/**
 * Favourite or unfavourite many images. Returns the ids that changed, so Undo reverses exactly
 * this call. Only live images are favourited; unfavouriting takes any.
 */
export function setFavourites(
  db: Executor,
  assetIds: readonly string[],
  on: boolean,
  at = nowIso(),
): string[] {
  return db.transaction((tx) => {
    const changed: string[] = [];
    for (const part of chunked([...new Set(assetIds)])) {
      const rows = on ? favouriteLive(tx, part, at) : unfavourite(tx, part);
      for (const row of rows) changed.push(row.assetId);
    }
    return changed;
  });
}

function favouriteLive(db: Executor, ids: string[], at: string): { assetId: string }[] {
  const live = liveIds(db, ids);
  if (live.length === 0) return [];
  // ON CONFLICT DO NOTHING returns only the rows it inserted: the ones that changed.
  return db
    .insert(favourites)
    .values(live.map((assetId) => ({ assetId, createdAt: at })))
    .onConflictDoNothing()
    .returning({ assetId: favourites.assetId })
    .all();
}

function unfavourite(db: Executor, ids: string[]): { assetId: string }[] {
  return db
    .delete(favourites)
    .where(inArray(favourites.assetId, ids))
    .returning({ assetId: favourites.assetId })
    .all();
}

/** The ids among these that are live images. */
function liveIds(db: Executor, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, [...ids]), isNull(assets.deletedAt)))
    .all()
    .map((r) => r.id);
}

// Folders

export type FolderWithCount = FolderRow & {
  /** Live images filed directly in the folder, not in its subfolders (§0.7). */
  count: number;
  /** Folders directly inside it. */
  childCount: number;
};

/**
 * Folders with their direct counts in one query (§8.2.2). Counts match what opening the folder
 * lists: live images, never masks.
 */
function foldersWithCounts(db: Executor, where?: SQL): FolderWithCount[] {
  // Subfolder counts grouped once, rather than a subquery per folder.
  const kids = db
    .select({
      parentId: sql<string>`${folders.parentId}`.as("kid_parent"),
      n: sql<number>`count(*)`.as("kids"),
    })
    .from(folders)
    .groupBy(folders.parentId)
    .as("kids");
  return db
    .select({
      folder: folders,
      count: sql<number>`count(${assets.id})`,
      childCount: sql<number>`coalesce(max(${kids.n}), 0)`,
    })
    .from(folders)
    .leftJoin(kids, eq(kids.parentId, folders.id))
    .leftJoin(assetFolders, eq(assetFolders.folderId, folders.id))
    .leftJoin(
      assets,
      and(eq(assets.id, assetFolders.assetId), isNull(assets.deletedAt), ne(assets.kind, "mask")),
    )
    .where(where)
    .groupBy(folders.id)
    .orderBy(asc(folders.sortOrder), sql`${folders.name} COLLATE NOCASE`, asc(folders.id))
    .all()
    .map((r) => ({ ...r.folder, count: r.count, childCount: r.childCount }));
}

/** Every folder, flat, with its direct counts. The client builds the tree from parentId. */
export function listFolders(db: Executor): FolderWithCount[] {
  return foldersWithCounts(db);
}

export function getFolder(db: Executor, id: string): FolderWithCount | undefined {
  return foldersWithCounts(db, eq(folders.id, id))[0];
}

export function createFolder(db: Executor, row: Draft<NewFolderRow, "createdAt" | "updatedAt">): FolderRow {
  const at = row.createdAt ?? nowIso();
  return db
    .insert(folders)
    .values({ ...row, createdAt: at, updatedAt: row.updatedAt ?? at })
    .returning()
    .get();
}

export function updateFolder(
  db: Executor,
  id: string,
  patch: Partial<Pick<NewFolderRow, "name" | "color" | "parentId" | "sortOrder">>,
): FolderRow | undefined {
  return db
    .update(folders)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(folders.id, id))
    .returning()
    .get();
}

export type FolderResult =
  | { ok: true; folder: FolderWithCount }
  | {
      ok: false;
      /** not_found and parent_not_found answer 404; cycle answers 409 conflict (§8.3). */
      reason: "not_found" | "parent_not_found" | "cycle";
    };

/** POST /api/folders: at the top level or inside another folder. */
export function addFolder(
  db: Executor,
  draft: { id: string; name: string; parentId?: string | null; color?: string | null },
): FolderResult {
  return db.transaction((tx) => {
    if (draft.parentId && !folderExists(tx, draft.parentId)) return { ok: false, reason: "parent_not_found" };
    createFolder(tx, { ...draft, parentId: draft.parentId ?? null });
    return { ok: true, folder: getFolder(tx, draft.id)! };
  });
}

/**
 * PATCH /api/folders/:id: rename and move in one transaction. A move under the folder itself or
 * any of its descendants is refused and nothing is written (§8.2.2). `parentId: null` moves it to
 * the top level; leaving parentId out keeps it where it is.
 */
export function patchFolder(
  db: Executor,
  id: string,
  patch: {
    name?: string;
    color?: string | null;
    sortOrder?: number;
    parentId?: string | null;
  },
): FolderResult {
  return db.transaction((tx) => {
    if (!folderExists(tx, id)) return { ok: false, reason: "not_found" };
    if (patch.parentId) {
      if (!folderExists(tx, patch.parentId)) return { ok: false, reason: "parent_not_found" };
      if (wouldNestInside(tx, id, patch.parentId)) return { ok: false, reason: "cycle" };
    }
    const set: Partial<NewFolderRow> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
    if (patch.parentId !== undefined) set.parentId = patch.parentId;
    updateFolder(tx, id, set);
    return { ok: true, folder: getFolder(tx, id)! };
  });
}

function folderExists(db: Executor, id: string): boolean {
  return db.select({ id: folders.id }).from(folders).where(eq(folders.id, id)).get() !== undefined;
}

/**
 * Whether putting `folderId` inside `parentId` would put it inside itself: walk up from the new
 * parent and see if the folder is on the way (§8.2.2). UNION stops on a loop, should one exist.
 */
export function wouldNestInside(db: Executor, folderId: string, parentId: string): boolean {
  if (folderId === parentId) return true;
  const hit = db.get<{ hit: number } | undefined>(sql`
    WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM folders WHERE id = ${parentId}
      UNION
      SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
    )
    SELECT 1 AS hit FROM up WHERE id = ${folderId} LIMIT 1
  `);
  return hit !== undefined && hit !== null;
}

/** The folder and every folder inside it, parents before children. Empty for an unknown id. */
export function folderSubtree(db: Executor, id: string): { id: string; parentId: string | null }[] {
  const rows = db.all<{ id: string; parentId: string | null }>(sql`
    WITH RECURSIVE down(id, parent_id) AS (
      SELECT id, parent_id FROM folders WHERE id = ${id}
      UNION
      SELECT f.id, f.parent_id FROM folders f JOIN down ON f.parent_id = down.id
    )
    SELECT id, parent_id AS parentId FROM down
  `);
  return breadthFirst(id, rows);
}

/** Orders a subtree by level from its root, whatever order the rows came in. */
function breadthFirst(
  rootId: string,
  rows: { id: string; parentId: string | null }[],
): { id: string; parentId: string | null }[] {
  const children = new Map<string, { id: string; parentId: string | null }[]>();
  let root: { id: string; parentId: string | null } | undefined;
  for (const row of rows) {
    if (row.id === rootId) root = row;
    else if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }
  if (!root) return [];
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!.id) ?? []));
  return out;
}

/** Deletes the folder only. Its subfolders go with it through the cascade; images stay. */
export function deleteFolder(db: Executor, id: string): boolean {
  return deleteFolderTree(db, id) !== null;
}

/**
 * DELETE /api/folders/:id: the folder, every folder inside it at any depth, and all their
 * memberships, in one transaction. Never an image (§0.7). Returns the ids it deleted, parents
 * first, or null for an unknown folder.
 */
export function deleteFolderTree(db: Executor, id: string): string[] | null {
  return db.transaction((tx) => {
    const subtree = folderSubtree(tx, id);
    if (subtree.length === 0) return null;
    // Deepest first: SQLite runs each cascade as a nested trigger and gives up past 1000 levels,
    // so the tree is taken apart bottom up and no cascade has a subfolder left to reach.
    const levels = levelsOf(subtree);
    for (let depth = levels.length - 1; depth >= 0; depth--) {
      for (const part of chunked(levels[depth]!)) tx.delete(folders).where(inArray(folders.id, part)).run();
    }
    return subtree.map((f) => f.id);
  });
}

function levelsOf(subtree: { id: string; parentId: string | null }[]): string[][] {
  const depth = new Map<string, number>();
  const levels: string[][] = [];
  for (const [i, folder] of subtree.entries()) {
    // Breadth-first order puts every parent before its children.
    const d = i === 0 ? 0 : (depth.get(folder.parentId ?? "") ?? 0) + 1;
    depth.set(folder.id, d);
    const level = levels[d] ?? [];
    level.push(folder.id);
    levels[d] = level;
  }
  return levels;
}

// What's filed where

/**
 * Files images into a folder and keeps every other folder they're in (§0.7). Images already there
 * and images in the Trash are skipped. Returns the ids it added, so Undo takes out only those, or
 * null for an unknown folder.
 */
export function addAssetsToFolder(
  db: Executor,
  folderId: string,
  assetIds: readonly string[],
  at = nowIso(),
): string[] | null {
  return db.transaction((tx) => {
    if (!folderExists(tx, folderId)) return null;
    const added: string[] = [];
    for (const part of chunked([...new Set(assetIds)])) {
      const ids = liveIds(tx, part);
      if (ids.length === 0) continue;
      const rows = tx
        .insert(assetFolders)
        .values(ids.map((assetId) => ({ assetId, folderId, addedAt: at })))
        .onConflictDoNothing()
        .returning({ assetId: assetFolders.assetId })
        .all();
      for (const row of rows) added.push(row.assetId);
    }
    return added;
  });
}

/**
 * Takes images out of one folder and no other (§0.7). Returns the ids it took out, or null for an
 * unknown folder.
 */
export function removeAssetsFromFolder(
  db: Executor,
  folderId: string,
  assetIds: readonly string[],
): string[] | null {
  return db.transaction((tx) => {
    if (!folderExists(tx, folderId)) return null;
    const removed: string[] = [];
    for (const part of chunked([...new Set(assetIds)])) {
      const rows = tx
        .delete(assetFolders)
        .where(and(eq(assetFolders.folderId, folderId), inArray(assetFolders.assetId, part)))
        .returning({ assetId: assetFolders.assetId })
        .all();
      for (const row of rows) removed.push(row.assetId);
    }
    return removed;
  });
}

export function addToFolder(
  db: Executor,
  folderId: string,
  assetIds: readonly string[],
  at = nowIso(),
): void {
  if (assetIds.length === 0) return;
  db.insert(assetFolders)
    .values(assetIds.map((assetId) => ({ assetId, folderId, addedAt: at })))
    .onConflictDoNothing()
    .run();
}

export function removeFromFolder(db: Executor, folderId: string, assetIds: readonly string[]): void {
  if (assetIds.length === 0) return;
  db.delete(assetFolders)
    .where(and(eq(assetFolders.folderId, folderId), inArray(assetFolders.assetId, [...assetIds])))
    .run();
}

export function foldersOfAsset(db: Executor, assetId: string): FolderRow[] {
  return db
    .select({ folder: folders })
    .from(assetFolders)
    .innerJoin(folders, eq(folders.id, assetFolders.folderId))
    .where(eq(assetFolders.assetId, assetId))
    .orderBy(asc(folders.sortOrder), asc(folders.name))
    .all()
    .map((r) => r.folder);
}

/**
 * The folders an image is in, with their counts, for the detail view's Folders row. For an image
 * in the Trash these are the folders Restore puts it back in.
 */
export function foldersOfAssetWithCounts(db: Executor, assetId: string): FolderWithCount[] {
  return foldersWithCounts(
    db,
    sql`${folders.id} IN (SELECT folder_id FROM asset_folders WHERE asset_id = ${assetId})`,
  );
}

/**
 * For the Add to folder picker: how many of these images each folder holds. A folder holding all
 * of them is on, some is mixed, and a folder that isn't listed is off.
 */
export function folderMemberships(
  db: Executor,
  assetIds: readonly string[],
): { folderId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const part of chunked([...new Set(assetIds)])) {
    const rows = db
      .select({ folderId: assetFolders.folderId, count: sql<number>`count(*)` })
      .from(assetFolders)
      .where(inArray(assetFolders.assetId, part))
      .groupBy(assetFolders.folderId)
      .all();
    for (const row of rows) counts.set(row.folderId, (counts.get(row.folderId) ?? 0) + row.count);
  }
  return [...counts].map(([folderId, count]) => ({ folderId, count }));
}
