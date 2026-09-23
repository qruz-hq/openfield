/** A migration failed. The whole batch was rolled back, so the file is as it was before boot. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
  constructor(
    /** Tag of the migration that failed, e.g. "0001_assets_fts", when it could be pinned down. */
    readonly migration: string | null,
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(migration ? `Migration ${migration} failed: ${reason}` : `Migrations failed: ${reason}`, { cause });
  }
}

/** A page cursor that we didn't mint. Routes answer 400. */
export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";
  constructor(readonly cursor: string) {
    super("Invalid page cursor");
  }
}

export interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/** Migrations applied but left rows pointing at nothing, so the database is not served. */
export class MigrationIntegrityError extends Error {
  override readonly name = "MigrationIntegrityError";
  constructor(readonly violations: ForeignKeyViolation[]) {
    const sample = violations
      .slice(0, 5)
      .map((v) => `${v.table} row ${v.rowid ?? "?"} -> ${v.parent}`)
      .join(", ");
    super(`Foreign key check failed after migrating (${violations.length} rows): ${sample}`);
  }
}
