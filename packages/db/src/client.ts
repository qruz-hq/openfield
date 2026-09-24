import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { type ForeignKeyViolation, MigrationError, MigrationIntegrityError } from "./errors";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = BunSQLiteDatabase<Schema> & { $client: Database };
/** The database or an open transaction. Every query helper accepts either. */
export type Executor = BaseSQLiteDatabase<"sync", void, Schema>;

/** Resolved from this file, so booting from any working directory finds the migrations. */
export const MIGRATIONS_FOLDER = join(import.meta.dir, "../migrations");

const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface OpenDb {
  db: Db;
  /** Newest applied migration, e.g. "0001_assets_fts". GET /api/health reports it. */
  schemaTag: string | null;
  close(): void;
}

/**
 * Opens (or creates) the database, applies pending migrations and turns foreign keys on
 * (§8.2.4). Throws MigrationError or MigrationIntegrityError instead of serving a bad file.
 */
export function openDb(file: string): OpenDb {
  const sqlite = new Database(file, { create: true });
  try {
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const db = drizzle({ client: sqlite, schema });

    // Foreign keys stay off while migrating: a drizzle-kit table rebuild drops and re-creates
    // a table, and with enforcement on that DROP would cascade into child rows.
    sqlite.exec("PRAGMA foreign_keys = OFF");
    try {
      adoptEarlyCanvas(sqlite);
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } catch (cause) {
      if (cause instanceof MigrationError) throw cause;
      throw new MigrationError(findFailingMigration(sqlite), cause);
    }
    const violations = sqlite.query("PRAGMA foreign_key_check").all() as ForeignKeyViolation[];
    if (violations.length > 0) throw new MigrationIntegrityError(violations);
    sqlite.exec("PRAGMA foreign_keys = ON");

    return { db, schemaTag: appliedTag(sqlite), close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

interface JournalEntry {
  tag: string;
  when: number;
}

function readJournal(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function lastAppliedMillis(sqlite: Database): number | null {
  const table = sqlite
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (!table) return null;
  const row = sqlite
    .query(`SELECT created_at AS at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`)
    .get() as { at: number | string } | null;
  return row ? Number(row.at) : null;
}

function appliedTag(sqlite: Database): string | null {
  const at = lastAppliedMillis(sqlite);
  return at === null ? null : (readJournal().find((e) => e.when === at)?.tag ?? null);
}

/**
 * Before the canvas work was merged, its migration shipped as 0003_canvas, stamped after the 0003
 * and 0004 it now follows. Drizzle only runs files newer than the last stamp, so a library made
 * then would skip those two and fail on 0006_canvas, the same file. Run what it skipped and
 * restamp the canvas row as 0006, all in one transaction.
 */
const EARLY_CANVAS_STAMP = 1790185934361;

function adoptEarlyCanvas(sqlite: Database): void {
  if (lastAppliedMillis(sqlite) === null) return;
  const rows = sqlite.query(`SELECT created_at AS at FROM ${MIGRATIONS_TABLE}`).all() as {
    at: number | string;
  }[];
  const stamped = new Set(rows.map((row) => Number(row.at)));
  if (!stamped.has(EARLY_CANVAS_STAMP)) return;
  const journal = readJournal();
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const canvas = files[journal.findIndex((e) => e.tag === "0006_canvas")];
  if (!canvas) return;
  sqlite.transaction(() => {
    for (const [i, file] of files.entries()) {
      if (file.folderMillis >= canvas.folderMillis || stamped.has(file.folderMillis)) continue;
      try {
        for (const statement of file.sql) sqlite.exec(statement);
      } catch (cause) {
        throw new MigrationError(journal[i]?.tag ?? null, cause);
      }
      sqlite
        .query(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`)
        .run(file.hash, file.folderMillis);
    }
    sqlite
      .query(`UPDATE ${MIGRATIONS_TABLE} SET hash = ?, created_at = ? WHERE created_at = ?`)
      .run(canvas.hash, canvas.folderMillis, EARLY_CANVAS_STAMP);
  })();
}

/**
 * Drizzle's migrator runs the whole batch in one transaction and doesn't say which file broke.
 * Replay the pending files in a throwaway transaction to name it, then roll everything back.
 */
function findFailingMigration(sqlite: Database): string | null {
  try {
    const journal = readJournal();
    const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    const since = lastAppliedMillis(sqlite) ?? -1;
    sqlite.exec("BEGIN");
    try {
      for (const [i, file] of files.entries()) {
        if (file.folderMillis <= since) continue;
        try {
          for (const statement of file.sql) sqlite.exec(statement);
        } catch {
          return journal[i]?.tag ?? null;
        }
      }
      return null;
    } finally {
      sqlite.exec("ROLLBACK");
    }
  } catch {
    return null;
  }
}
