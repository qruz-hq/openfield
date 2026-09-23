import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { assetFolders, assets, favourites, settings } from "../schema";
import { nowIso, type Page, pageSize, toPage } from "./_util";
import { type FeedItem, type FeedQuery, feedFilters, isFavouriteExpr } from "./assets";

export type SearchItem = FeedItem & { excerpt: string };

const MAX_TERMS = 16;

/**
 * Turns what the person typed into a safe FTS5 query: every word is quoted, so FTS syntax
 * characters are plain text, and the last word matches as a prefix while they type.
 * Returns null when there is nothing to search for.
 */
export function toFtsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((t) => t.replaceAll('"', ""))
    // A word with no letters or digits has no tokens, and an empty phrase is an FTS5 error.
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

/**
 * Prompt and tag search (§8.2.2). Chronological, not ranked, and paged with the same cursor
 * as the feed so results scroll the same way.
 */
export function searchAssets(db: Executor, q: FeedQuery & { text: string }): Page<SearchItem> {
  const match = toFtsQuery(q.text);
  if (!match) return { items: [], nextCursor: null };
  const limit = pageSize(q.limit);
  let query = db
    .select({
      asset: assets,
      isFavourite: isFavouriteExpr,
      excerpt: sql<string>`snippet(assets_fts, 0, '<mark>', '</mark>', '…', 12)`,
    })
    .from(assets)
    .innerJoin(sql`assets_fts`, sql`assets_fts.rowid = ${assets}.rowid`)
    .leftJoin(favourites, eq(favourites.assetId, assets.id))
    .$dynamic();
  if (q.folderId) {
    query = query.innerJoin(
      assetFolders,
      and(eq(assetFolders.assetId, assets.id), eq(assetFolders.folderId, q.folderId)),
    );
  }
  const where = [sql`assets_fts MATCH ${match}`, ...feedFilters(q)];
  if (q.favouritesOnly) where.push(isNotNull(favourites.assetId));
  const rows = query
    .where(and(...where))
    .orderBy(desc(assets.createdAt), desc(assets.id))
    .limit(limit + 1)
    .all();
  return toPage(
    rows.map((r) => ({ ...r.asset, isFavourite: r.isFavourite, excerpt: r.excerpt })),
    limit,
    (a) => a,
  );
}

/** Rebuilds the search index from assets. Run after a restore, before serving (§0.7). */
export function rebuildSearchIndex(db: Executor): void {
  db.run(sql`INSERT INTO assets_fts(assets_fts) VALUES('rebuild')`);
}

/** Not a setting: readSettings skips keys it doesn't know. */
const DB_FILE_KEY = "internal.dbFile";

/**
 * Rebuilds the search index when the database file isn't the one it last opened as, like a
 * restored backup or a copied library, whose index may point at the wrong rows (§0.7).
 * `fileId` identifies the file on disk (its inode). Returns what the database remembered, and
 * whether it rebuilt.
 */
export function rebuildSearchIndexIfReplaced(
  db: Executor,
  fileId: string,
): { rebuilt: boolean; previous: string | null } {
  const row = db.select().from(settings).where(eq(settings.key, DB_FILE_KEY)).get();
  const previous = typeof row?.value === "string" ? row.value : null;
  if (previous === fileId) return { rebuilt: false, previous };
  db.transaction((tx) => {
    rebuildSearchIndex(tx);
    const value = sql`${JSON.stringify(fileId)}`;
    tx.insert(settings)
      .values({ key: DB_FILE_KEY, value, updatedAt: nowIso() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso() } })
      .run();
  });
  return { rebuilt: true, previous };
}
