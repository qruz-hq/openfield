import { type SQL, sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * `column IN ('a','b',…)` from a core constant. Bare column names only, so a drizzle-kit
 * table rebuild can't carry a stale table qualifier (§8.2).
 */
export const oneOf = (column: string, values: readonly string[]): SQL =>
  sql.raw(`${column} IN (${values.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")})`);

/** Boolean in TS, 0/1 in SQLite. A raw default keeps the migration at DEFAULT 0|1, not true/false. */
export const flag = (name: string, dflt: 0 | 1) =>
  integer(name, { mode: "boolean" })
    .notNull()
    .default(sql.raw(String(dflt)));

export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
