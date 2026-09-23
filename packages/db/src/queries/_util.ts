import { ASSET_PAGE_SIZE, decodeCursor, encodeCursor, MAX_PAGE_SIZE } from "@openfield/core";
import { type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { InvalidCursorError } from "../errors";

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

export interface PageQuery {
  cursor?: string | null;
  /** Default 50, the measured feed page size (§8.2.2). */
  limit?: number;
}

/** An insert row where the helper fills the listed columns when they're left out. */
export type Draft<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Timestamps are ISO-8601 UTC text (§8.2). */
export const nowIso = (): string => new Date().toISOString();

export const pageSize = (limit?: number): number =>
  Math.min(Math.max(1, Math.trunc(limit ?? ASSET_PAGE_SIZE)), MAX_PAGE_SIZE);

/** Keyset condition for newest-first pages: rows strictly after the cursor's (created_at, id). */
export function olderThan(
  createdAt: SQLiteColumn,
  id: SQLiteColumn,
  cursor?: string | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const at = decodeCursor(cursor);
  if (!at) throw new InvalidCursorError(cursor);
  return sql`(${createdAt}, ${id}) < (${at.createdAt}, ${at.id})`;
}

/** Callers fetch limit + 1 rows; the extra row only says whether another page exists. */
export function toPage<T>(
  rows: T[],
  limit: number,
  key: (row: T) => { createdAt: string; id: string },
): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = key(items[items.length - 1]!);
  return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
}
