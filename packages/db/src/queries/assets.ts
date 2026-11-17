import type { AssetKind, FileState, Modality } from "@openfield/core/constants";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { AssetRow, NewAssetRow } from "../rows";
import { assets, favourites } from "../schema";
import { type Draft, nowIso, olderThan, type PageQuery } from "./_util";

export type FeedItem = AssetRow & { isFavourite: boolean };

export interface FeedQuery extends PageQuery {
  /** Images, videos, or "all". The feed and search default to images; the library to all. */
  modality?: Modality | "all";
  folderId?: string;
  favouritesOnly?: boolean;
  modelId?: string;
  providerId?: string;
  kind?: AssetKind;
  /** created_at range: from inclusive, to exclusive. */
  from?: string;
  to?: string;
}

export const isFavouriteExpr = sql<boolean>`(${favourites.assetId} IS NOT NULL)`.mapWith((v) => v === 1);

/** Filters shared by the feed and search. Always live assets only, and never masks (§8.3). */
export function feedFilters(q: FeedQuery): SQL[] {
  const where: (SQL | undefined)[] = [
    isNull(assets.deletedAt),
    modalityIs(q.modality ?? "image"),
    ne(assets.kind, "mask"),
    q.modelId ? eq(assets.modelId, q.modelId) : undefined,
    q.providerId ? eq(assets.providerId, q.providerId) : undefined,
    q.kind ? eq(assets.kind, q.kind) : undefined,
    q.from ? gte(assets.createdAt, q.from) : undefined,
    q.to ? lt(assets.createdAt, q.to) : undefined,
    olderThan(assets.createdAt, assets.id, q.cursor),
  ];
  return where.filter((c): c is SQL => c !== undefined);
}

/** A modality filter, or none for "all". */
export const modalityIs = (modality: Modality | "all"): SQL | undefined =>
  modality === "all" ? undefined : eq(assets.modality, modality);

/** An original is its own lineage root, so rootAssetId defaults to the asset's id. */
export function insertAsset(
  db: Executor,
  row: Draft<NewAssetRow, "createdAt" | "updatedAt" | "rootAssetId">,
): AssetRow {
  const at = row.createdAt ?? nowIso();
  return db
    .insert(assets)
    .values({ ...row, rootAssetId: row.rootAssetId ?? row.id, createdAt: at, updatedAt: row.updatedAt ?? at })
    .returning()
    .get();
}

export function getAsset(
  db: Executor,
  id: string,
  opts: { includeDeleted?: boolean } = {},
): AssetRow | undefined {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), opts.includeDeleted ? undefined : isNull(assets.deletedAt)))
    .get();
}

export function getAssets(db: Executor, ids: readonly string[]): AssetRow[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(assets)
    .where(and(inArray(assets.id, [...ids]), isNull(assets.deletedAt)))
    .all();
}

/** Ingest dedupe: identical bytes already in the live library (§8.5.1). */
/** The oldest live asset with these bytes, optionally of one kind only. */
export function findLiveAssetBySha256(db: Executor, sha256: string, kind?: AssetKind): AssetRow | undefined {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.sha256, sha256), isNull(assets.deletedAt), kind ? eq(assets.kind, kind) : undefined))
    .orderBy(asc(assets.createdAt))
    .get();
}

/** A live mask with these bytes, drawn for this image: saving the same mask again finds it. */
export function findLiveMask(db: Executor, sha256: string, parentAssetId: string): AssetRow | undefined {
  return db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.sha256, sha256),
        eq(assets.kind, "mask"),
        eq(assets.parentAssetId, parentAssetId),
        isNull(assets.deletedAt),
      ),
    )
    .orderBy(asc(assets.createdAt))
    .get();
}

export function assetsForJobSets(db: Executor, jobSetIds: readonly string[]): AssetRow[] {
  if (jobSetIds.length === 0) return [];
  return db
    .select()
    .from(assets)
    .where(and(inArray(assets.jobSetId, [...jobSetIds]), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt))
    .all();
}

/**
 * Version strip and History: one index scan per lineage root, no recursion (§0.7). Masks share
 * their image's root but aren't versions of it.
 */
export function assetVersions(db: Executor, rootAssetId: string): AssetRow[] {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.rootAssetId, rootAssetId), isNull(assets.deletedAt), ne(assets.kind, "mask")))
    .orderBy(asc(assets.createdAt))
    .all();
}

export function updateAssetTags(db: Executor, id: string, tags: string): AssetRow | undefined {
  return db
    .update(assets)
    .set({ tags, updatedAt: nowIso() })
    .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
    .returning()
    .get();
}

export function setAssetFileState(db: Executor, id: string, fileState: FileState): void {
  db.update(assets).set({ fileState, updatedAt: nowIso() }).where(eq(assets.id, id)).run();
}

/** Moves assets to the trash. Files and the search row stay (§0.7). Returns the ids it moved. */
export function softDeleteAssets(db: Executor, ids: readonly string[], at = nowIso()): string[] {
  if (ids.length === 0) return [];
  return db
    .update(assets)
    .set({ deletedAt: at, updatedAt: at })
    .where(and(inArray(assets.id, [...ids]), isNull(assets.deletedAt)))
    .returning({ id: assets.id })
    .all()
    .map((r) => r.id);
}

export function restoreAsset(db: Executor, id: string): AssetRow | undefined {
  return db
    .update(assets)
    .set({ deletedAt: null, updatedAt: nowIso() })
    .where(and(eq(assets.id, id), isNotNull(assets.deletedAt)))
    .returning()
    .get();
}

/**
 * Removes the row for good; folders, favourites and child edges cascade, children keep their
 * parent id as a tombstone. Returns the row so the caller can delete the file and, when
 * `hashStillLive` says no, its thumbnails.
 */
export function hardDeleteAsset(db: Executor, id: string): AssetRow | undefined {
  return db.delete(assets).where(eq(assets.id, id)).returning().get();
}

/** Trashed before `cutoff`, for the optional retention purge (§8.6). */
export function trashedBefore(db: Executor, cutoff: string): AssetRow[] {
  return db
    .select()
    .from(assets)
    .where(and(isNotNull(assets.deletedAt), lt(assets.deletedAt, cutoff)))
    .all();
}

export interface LibraryStats {
  assets: number;
  bytes: number;
  trash: { count: number; bytes: number };
}

/**
 * Settings > Storage counts (§8.2.2). Thumbnail and database sizes come from the disk. Masks are
 * never counted as images, as the library never lists them, but their bytes are on disk too, as
 * are an edit's stored model result and fix layer, counted with the edit (in the Trash with it). A
 * stored result that is the edit's own file (Keep the rest off) isn't counted twice.
 */
export function libraryStats(db: Executor): LibraryStats {
  const image = sql`${assets.kind} <> 'mask'`;
  const extra = sql`(CASE WHEN ${assets.resultPath} IS NOT NULL AND ${assets.resultPath} <> ${assets.path} THEN coalesce(${assets.resultBytes}, 0) ELSE 0 END + coalesce(${assets.fixesBytes}, 0))`;
  const row = db
    .select({
      assets: sql<number>`coalesce(sum(${assets.deletedAt} IS NULL AND ${image}), 0)`,
      bytes: sql<number>`coalesce(sum(CASE WHEN ${assets.deletedAt} IS NULL THEN ${assets.bytes} + ${extra} END), 0)`,
      trashCount: sql<number>`coalesce(sum(${assets.deletedAt} IS NOT NULL AND ${image}), 0)`,
      trashBytes: sql<number>`coalesce(sum(CASE WHEN ${assets.deletedAt} IS NOT NULL THEN ${assets.bytes} + ${extra} END), 0)`,
    })
    .from(assets)
    .get();
  return {
    assets: row?.assets ?? 0,
    bytes: row?.bytes ?? 0,
    trash: { count: row?.trashCount ?? 0, bytes: row?.trashBytes ?? 0 },
  };
}

/**
 * Swaps an edit's kept file for another, after its Keep the rest settings changed (§0.9): the
 * file, its size and hash, its record, and its fix layer. Live edits only. The model's own result
 * stays where it is. Returns the row as it was and as it is now, so the caller can delete the old
 * files no row names any more.
 */
export function replaceKeptFile(
  db: Executor,
  id: string,
  next: Pick<AssetRow, "path" | "bytes" | "sha256" | "opParams" | "fixesPath" | "fixesBytes">,
  at = nowIso(),
): { before: AssetRow; after: AssetRow } | undefined {
  const before = getAsset(db, id);
  if (!before) return undefined;
  const after = db
    .update(assets)
    .set({ ...next, updatedAt: at })
    .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
    .returning()
    .get();
  return after ? { before, after } : undefined;
}
