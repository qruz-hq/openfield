import type { AssetKind, FileState, Modality } from "@openfield/core/constants";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { AssetRow, NewAssetRow } from "../rows";
import { assetFolders, assets, favourites } from "../schema";
import { type Draft, nowIso, olderThan, type Page, type PageQuery, pageSize, toPage } from "./_util";

export type FeedItem = AssetRow & { isFavourite: boolean };

export interface FeedQuery extends PageQuery {
  modality?: Modality;
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

/** Filters shared by the feed and search. Always live assets only. */
export function feedFilters(q: FeedQuery): SQL[] {
  const where: (SQL | undefined)[] = [
    isNull(assets.deletedAt),
    eq(assets.modality, q.modality ?? "image"),
    q.modelId ? eq(assets.modelId, q.modelId) : undefined,
    q.providerId ? eq(assets.providerId, q.providerId) : undefined,
    q.kind ? eq(assets.kind, q.kind) : undefined,
    q.from ? gte(assets.createdAt, q.from) : undefined,
    q.to ? lt(assets.createdAt, q.to) : undefined,
    olderThan(assets.createdAt, assets.id, q.cursor),
  ];
  return where.filter((c): c is SQL => c !== undefined);
}

/**
 * One page of the feed or library, newest first, keyset-paged on (created_at, id) (§8.2.2).
 * Width and height come with every row so the client can lay out rows before any image loads.
 */
export function feedPage(db: Executor, q: FeedQuery = {}): Page<FeedItem> {
  const limit = pageSize(q.limit);
  let query = db
    .select({ asset: assets, isFavourite: isFavouriteExpr })
    .from(assets)
    .leftJoin(favourites, eq(favourites.assetId, assets.id))
    .$dynamic();
  if (q.folderId) {
    query = query.innerJoin(
      assetFolders,
      and(eq(assetFolders.assetId, assets.id), eq(assetFolders.folderId, q.folderId)),
    );
  }
  const where = feedFilters(q);
  if (q.favouritesOnly) where.push(isNotNull(favourites.assetId));
  const rows = query
    .where(and(...where))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(limit + 1)
    .all();
  return toPage(
    rows.map((r) => ({ ...r.asset, isFavourite: r.isFavourite })),
    limit,
    (a) => a,
  );
}

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

export function assetsForJobSets(db: Executor, jobSetIds: readonly string[]): AssetRow[] {
  if (jobSetIds.length === 0) return [];
  return db
    .select()
    .from(assets)
    .where(and(inArray(assets.jobSetId, [...jobSetIds]), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt))
    .all();
}

/** Version strip and History: one index scan per lineage root, no recursion (§0.7). */
export function assetVersions(db: Executor, rootAssetId: string): AssetRow[] {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.rootAssetId, rootAssetId), isNull(assets.deletedAt)))
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

/** Settings > Storage counts (§8.2.2). Thumbnail and database sizes come from the disk. */
export function libraryStats(db: Executor): LibraryStats {
  const row = db
    .select({
      assets: sql<number>`coalesce(sum(${assets.deletedAt} IS NULL), 0)`,
      bytes: sql<number>`coalesce(sum(CASE WHEN ${assets.deletedAt} IS NULL THEN ${assets.bytes} END), 0)`,
      trashCount: sql<number>`coalesce(sum(${assets.deletedAt} IS NOT NULL), 0)`,
      trashBytes: sql<number>`coalesce(sum(CASE WHEN ${assets.deletedAt} IS NOT NULL THEN ${assets.bytes} END), 0)`,
    })
    .from(assets)
    .get();
  return {
    assets: row?.assets ?? 0,
    bytes: row?.bytes ?? 0,
    trash: { count: row?.trashCount ?? 0, bytes: row?.trashBytes ?? 0 },
  };
}
