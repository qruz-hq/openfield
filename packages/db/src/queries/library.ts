import { decodeCursor } from "@openfield/core";
import type { Modality } from "@openfield/core/constants";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { InvalidCursorError } from "../errors";
import type { AssetRow } from "../rows";
import { assets } from "../schema";
import { chunked, nowIso, type Page, pageSize, toPage } from "./_util";
import { type FeedItem, type FeedQuery, modalityIs } from "./assets";
import { toFtsQuery } from "./search";

// The Assets library's listings (§2.8, §8.2.2): every view, search and filter on the one
// (created_at, id) cursor, the Trash on (deleted_at, id), counts, the neighbours the detail view
// steps to, and the Trash's restore and purge.

export interface LibraryFilter extends FeedQuery {
  /** Search words. Blank means no search. */
  text?: string;
  /**
   * Deleted images instead of live ones, newest deletion first. Ignores the words, folder,
   * favourites and filters, as the Trash has none (§2.8).
   */
  trash?: boolean;
}

export type LibraryPage = Page<FeedItem> & {
  /** How many images match. Only on the first page, so scrolling never pays for the count. */
  total?: number;
};

const itemFields = {
  asset: assets,
  isFavourite:
    sql<boolean>`EXISTS (SELECT 1 FROM favourites WHERE favourites.asset_id = ${assets.id})`.mapWith(
      (v) => v === 1,
    ),
};

/**
 * The WHERE for a listing, without the cursor. Folder, favourites and search are subqueries rather
 * than joins, so the listing, its count and the neighbour lookups share one shape. Null when the
 * words hold nothing searchable: that search matches nothing.
 */
function scope(q: LibraryFilter): SQL[] | null {
  // The library lists images and videos together unless asked for one (§2.8).
  const modality = modalityIs(q.modality ?? "all");
  // Masks are internal: never listed, never counted (§8.3).
  const notMask = ne(assets.kind, "mask");
  if (q.trash)
    return [isNotNull(assets.deletedAt), modality, notMask].filter((c): c is SQL => c !== undefined);

  const where: (SQL | undefined)[] = [
    isNull(assets.deletedAt),
    modality,
    notMask,
    q.kind ? eq(assets.kind, q.kind) : undefined,
    q.modelId ? eq(assets.modelId, q.modelId) : undefined,
    q.providerId ? eq(assets.providerId, q.providerId) : undefined,
    q.from ? gte(assets.createdAt, q.from) : undefined,
    q.to ? lt(assets.createdAt, q.to) : undefined,
    // Filed directly in the folder, not in its subfolders (§0.7).
    q.folderId
      ? sql`${assets.id} IN (SELECT asset_id FROM asset_folders WHERE folder_id = ${q.folderId})`
      : undefined,
    q.favouritesOnly ? sql`${assets.id} IN (SELECT asset_id FROM favourites)` : undefined,
  ];
  if (q.text?.trim()) {
    const match = toFtsQuery(q.text);
    if (!match) return null;
    where.push(sql`${assets}.rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ${match})`);
  }
  return where.filter((c): c is SQL => c !== undefined);
}

/** The column a view is ordered and paged by. */
const orderColumn = (q: LibraryFilter) => (q.trash ? assets.deletedAt : assets.createdAt);

/** Rows strictly after (older) or before (newer) the position (at, id) in the view's order. */
function beyond(q: LibraryFilter, at: string, id: string, direction: "older" | "newer"): SQL {
  const column = orderColumn(q);
  return direction === "older"
    ? sql`(${column}, ${assets.id}) < (${at}, ${id})`
    : sql`(${column}, ${assets.id}) > (${at}, ${id})`;
}

function afterCursor(q: LibraryFilter, cursor: string): SQL {
  const at = decodeCursor(cursor);
  if (!at) throw new InvalidCursorError(cursor);
  return beyond(q, at.createdAt, at.id, "older");
}

const toItem = (row: { asset: AssetRow; isFavourite: boolean }): FeedItem => ({
  ...row.asset,
  isFavourite: row.isFavourite,
});

/**
 * One page of a library view, newest first: All images, Favorites, a folder, search results with
 * any filters, or the Trash (§8.2.2). The first page also carries the total for the header.
 */
export function libraryPage(db: Executor, q: LibraryFilter, opts: { total?: boolean } = {}): LibraryPage {
  const withTotal = (opts.total ?? true) && !q.cursor;
  const where = scope(q);
  if (!where) return { items: [], nextCursor: null, ...(withTotal && { total: 0 }) };
  const limit = pageSize(q.limit);
  const column = orderColumn(q);
  const rows = db
    .select(itemFields)
    .from(assets)
    .where(and(...where, q.cursor ? afterCursor(q, q.cursor) : undefined))
    .orderBy(desc(column), desc(assets.id))
    .limit(limit + 1)
    .all();
  const page: LibraryPage = toPage(rows.map(toItem), limit, (a) => ({
    // A trashed row always has deleted_at; the fallback only keeps the types honest.
    createdAt: q.trash ? (a.deletedAt ?? a.createdAt) : a.createdAt,
    id: a.id,
  }));
  if (withTotal) page.total = countLibrary(db, q);
  return page;
}

/**
 * One page of the feed, newest first (§8.2.2). Width and height come with every row so the client
 * can lay out rows before any image loads. The same listing as the library, without the total.
 */
export function feedPage(db: Executor, q: FeedQuery = {}): Page<FeedItem> {
  return libraryPage(db, q, { total: false });
}

/** How many images a view holds, for the header. The cursor is ignored. */
export function countLibrary(db: Executor, q: LibraryFilter): number {
  const where = scope(q);
  if (!where) return 0;
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(assets)
      .where(and(...where))
      .get()?.n ?? 0
  );
}

/** One page of the Trash, newest deletion first, on (deleted_at, id) (§8.2.2). */
export function trashPage(db: Executor, q: Pick<LibraryFilter, "cursor" | "limit"> = {}): LibraryPage {
  return libraryPage(db, { ...q, trash: true }, { total: false });
}

export interface Neighbours {
  /** Newer: shown before it. */
  previous: FeedItem | null;
  /** Older: shown after it. */
  next: FeedItem | null;
}

/**
 * The images either side of one image in a view, for the detail view's arrows when the image isn't
 * in a loaded page, such as after a reload with ?asset=. Undefined for an unknown image. An image
 * outside the view (removed from the folder, say) still gets the neighbours of where it would sit.
 */
export function assetNeighbours(db: Executor, q: LibraryFilter, id: string): Neighbours | undefined {
  const pivot = db
    .select({ createdAt: assets.createdAt, deletedAt: assets.deletedAt })
    .from(assets)
    .where(eq(assets.id, id))
    .get();
  if (!pivot) return undefined;
  const where = scope(q);
  const at = q.trash ? pivot.deletedAt : pivot.createdAt;
  if (!where || !at) return { previous: null, next: null };
  const column = orderColumn(q);
  const one = (direction: "older" | "newer") => {
    const order = direction === "older" ? desc : asc;
    const row = db
      .select(itemFields)
      .from(assets)
      .where(and(...where, beyond(q, at, id, direction)))
      .orderBy(order(column), order(assets.id))
      .limit(1)
      .get();
    return row ? toItem(row) : null;
  };
  return { previous: one("newer"), next: one("older") };
}

export interface LibraryCounts {
  /** Live images. */
  all: number;
  /** Live favourites. */
  favourites: number;
  /** Images in the Trash. */
  trash: number;
}

/**
 * The sidebar's counts in one pass (§2.8): images and videos alike, unless asked for one. Masks
 * never count.
 */
export function libraryCounts(db: Executor, modality: Modality | "all" = "all"): LibraryCounts {
  const row = db
    .select({
      all: sql<number>`coalesce(sum(${assets.deletedAt} IS NULL), 0)`,
      favourites: sql<number>`coalesce(sum(${assets.deletedAt} IS NULL AND ${assets.id} IN (SELECT asset_id FROM favourites)), 0)`,
      trash: sql<number>`coalesce(sum(${assets.deletedAt} IS NOT NULL), 0)`,
    })
    .from(assets)
    .where(and(ne(assets.kind, "mask"), modalityIs(modality)))
    .get();
  return { all: row?.all ?? 0, favourites: row?.favourites ?? 0, trash: row?.trash ?? 0 };
}

export interface LibraryFacets {
  models: { providerId: string; modelId: string; count: number }[];
  providers: { providerId: string; count: number }[];
}

/** The models and companies that made a live image, for the Model and Company filters (§2.8). */
export function libraryFacets(db: Executor, modality: Modality | "all" = "all"): LibraryFacets {
  const live = and(isNull(assets.deletedAt), ne(assets.kind, "mask"), modalityIs(modality));
  const models = db
    .select({ providerId: assets.providerId, modelId: assets.modelId, count: sql<number>`count(*)` })
    .from(assets)
    .where(and(live, isNotNull(assets.providerId), isNotNull(assets.modelId)))
    .groupBy(assets.providerId, assets.modelId)
    .orderBy(asc(assets.providerId), asc(assets.modelId))
    .all();
  const providers = db
    .select({ providerId: assets.providerId, count: sql<number>`count(*)` })
    .from(assets)
    .where(and(live, isNotNull(assets.providerId)))
    .groupBy(assets.providerId)
    .orderBy(asc(assets.providerId))
    .all();
  return {
    models: models.map((m) => ({ providerId: m.providerId!, modelId: m.modelId!, count: m.count })),
    providers: providers.map((p) => ({ providerId: p.providerId!, count: p.count })),
  };
}

// Trash

/**
 * Takes images out of the Trash. Their folders and favourite were kept, so they come back where
 * they were (§0.7). Returns the ids it restored; images that weren't in the Trash are skipped.
 */
export function restoreAssets(db: Executor, ids: readonly string[], at = nowIso()): string[] {
  const out: string[] = [];
  for (const part of chunked([...new Set(ids)])) {
    const restored = db
      .update(assets)
      .set({ deletedAt: null, updatedAt: at })
      .where(and(inArray(assets.id, part), isNotNull(assets.deletedAt)))
      .returning({ id: assets.id })
      .all();
    for (const row of restored) out.push(row.id);
  }
  return out;
}

export interface PurgeResult {
  /** The rows removed. Folders, favourites and child edges went with them. */
  deleted: AssetRow[];
  /** Files no remaining row points at: delete these from disk. Shared files are left alone. */
  files: string[];
  /** Hashes no remaining row has: delete their thumbnails. */
  hashes: string[];
  /** Bytes of `files`. */
  reclaimedBytes: number;
}

/**
 * Deletes images for good, in one transaction, and says which files and thumbnails the caller may
 * now remove (§8.6). Identical bytes can back several rows (an upload of a generated image, say),
 * so a file or hash still used by another row, live or in the Trash, is kept. By default only
 * images in the Trash are touched; `includeLive` is DELETE /api/assets/:id?hard=1.
 */
export function purgeAssets(
  db: Executor,
  ids: readonly string[],
  opts: { includeLive?: boolean } = {},
): PurgeResult {
  return db.transaction((tx) => {
    const deleted: AssetRow[] = [];
    for (const part of chunked([...new Set(ids)])) {
      const rows = tx
        .delete(assets)
        .where(and(inArray(assets.id, part), opts.includeLive ? undefined : isNotNull(assets.deletedAt)))
        .returning()
        .all();
      deleted.push(...rows);
    }
    return orphansOf(tx, deleted);
  });
}

/** Empty trash: every image in the Trash, deleted for good (§8.6). */
export function emptyTrash(db: Executor): PurgeResult {
  return db.transaction((tx) => {
    const deleted = tx.delete(assets).where(isNotNull(assets.deletedAt)).returning().all();
    return orphansOf(tx, deleted);
  });
}

function orphansOf(db: Executor, deleted: AssetRow[]): PurgeResult {
  const bytesByPath = new Map<string, number>();
  for (const row of deleted) bytesByPath.set(row.path, row.bytes);
  const hashes = new Set(deleted.map((row) => row.sha256));

  const stillUsed = (column: typeof assets.path | typeof assets.sha256, values: string[]) => {
    const used = new Set<string>();
    for (const part of chunked(values)) {
      for (const row of db
        .selectDistinct({ value: column })
        .from(assets)
        .where(inArray(column, part))
        .all()) {
        used.add(row.value);
      }
    }
    return used;
  };
  const usedPaths = stillUsed(assets.path, [...bytesByPath.keys()]);
  const usedHashes = stillUsed(assets.sha256, [...hashes]);
  const orphaned = [...bytesByPath.keys()].filter((path) => !usedPaths.has(path));
  // A video's poster goes with its file: identical videos share both.
  const posters = deleted.flatMap((row) =>
    row.posterPath && orphaned.includes(row.path) ? [row.posterPath] : [],
  );
  const files = [...orphaned, ...new Set(posters)];
  return {
    deleted,
    files,
    hashes: [...hashes].filter((sha) => !usedHashes.has(sha)),
    reclaimedBytes: files.reduce((sum, path) => sum + (bytesByPath.get(path) ?? 0), 0),
  };
}
