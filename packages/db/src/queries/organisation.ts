import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { FolderRow, NewFolderRow } from "../rows";
import { assetFolders, assets, favourites, folders } from "../schema";
import { type Draft, nowIso } from "./_util";

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

// Folders

export type FolderWithCount = FolderRow & { count: number };

/** Every folder with its count of live assets. */
export function listFolders(db: Executor): FolderWithCount[] {
  return db
    .select({
      folder: folders,
      count: sql<number>`count(${assets.id})`,
    })
    .from(folders)
    .leftJoin(assetFolders, eq(assetFolders.folderId, folders.id))
    .leftJoin(assets, and(eq(assets.id, assetFolders.assetId), isNull(assets.deletedAt)))
    .groupBy(folders.id)
    .orderBy(asc(folders.sortOrder), asc(folders.name))
    .all()
    .map((r) => ({ ...r.folder, count: r.count }));
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

/** Deletes the folder and its subfolders. The assets in them stay in the library. */
export function deleteFolder(db: Executor, id: string): boolean {
  return db.delete(folders).where(eq(folders.id, id)).returning({ id: folders.id }).get() !== undefined;
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
