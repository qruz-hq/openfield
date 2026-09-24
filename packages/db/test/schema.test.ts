// Migrates a fresh database and checks it against §8.2: tables, columns, indices (§8.2.1),
// CHECK lists (built from core's constants), foreign keys, the FTS objects (§8.2.3) and the
// boot rules (§8.2.4). If this fails after a schema edit, the migration and the spec disagree.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSET_KINDS,
  AUTH_KINDS,
  BATCH_STATES,
  CANVAS_RUN_SCOPES,
  CANVAS_VERSION_KINDS,
  CHARACTER_INJECTIONS,
  COST_SOURCES,
  CREDENTIAL_SOURCES,
  EDGE_RELATIONS,
  FILE_STATES,
  JOB_SET_STATES,
  JOB_SOURCES,
  JOB_STATES,
  MODALITIES,
  MODEL_SOURCES,
  OPS,
  PALETTE_MODES,
  PRESET_ASSET_ROLES,
  REFERENCE_SET_ROLES,
  SPEED_IDS,
  USAGE_OUTCOMES,
} from "@openfield/core/constants";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  feedPage,
  getAsset,
  hardDeleteAsset,
  insertAsset,
  MIGRATIONS_FOLDER,
  MigrationError,
  MigrationIntegrityError,
  type OpenDb,
  openDb,
  readSettings,
  rebuildSearchIndex,
  rebuildSearchIndexIfReplaced,
  schema,
  searchAssets,
  softDeleteAssets,
  updateAssetTags,
} from "../src";

let dir: string;
let file: string;
let opened: OpenDb;
let raw: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openfield-db-"));
  file = join(dir, "openfield.db");
  opened = openDb(file);
  raw = opened.db.$client;
});

afterAll(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Whitespace-, quote- and case-insensitive, so formatting never fails the comparison. */
const norm = (s: string) =>
  s
    .replace(/[`"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();

const master = (type: string) =>
  raw.query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = ?").all(type) as {
    name: string;
    tbl_name: string;
    sql: string | null;
  }[];

// §8.2, column by column: "name type[ not null][ default x][ pk|pkN]".
const COLUMNS: Record<string, string[]> = {
  providers: [
    "id text not null pk",
    "display_name text not null",
    "adapter text not null",
    "auth_kind text not null",
    "credential_ref text",
    "credential_source text not null default 'unset'",
    "credential_hint text",
    "base_url text",
    "enabled integer not null default 1",
    "concurrency_cap integer not null default 2",
    "last_ok_at text",
    "last_error text",
    "created_at text not null",
    "updated_at text not null",
    "settings text",
  ],
  models: [
    "provider_id text not null pk1",
    "model_id text not null pk2",
    "display_name text not null",
    "family text",
    "modality text not null default 'image'",
    "badges text",
    "capabilities text not null",
    "pricing text",
    "source text not null",
    "enabled integer not null default 1",
    "sort_order integer not null default 0",
    "discovered_at text",
    "updated_at text not null",
    "speeds text",
  ],
  job_sets: [
    "id text not null pk",
    "idempotency_key text",
    "op text not null",
    "modality text not null default 'image'",
    "provider_id text not null",
    "model_id text not null",
    "prompt text not null default ''",
    "prompt_original text",
    "negative_prompt text",
    "request_json text not null",
    "batch_size integer not null default 1",
    "priority integer not null default 10",
    "status text not null default 'pending'",
    "source text not null default 'composer'",
    "canvas_id text",
    "canvas_node_id text",
    "canvas_run_id text",
    "cost_estimate_usd real",
    "cost_actual_usd real",
    "error_code text",
    "error_message text",
    "created_at text not null",
    "started_at text",
    "finished_at text",
    "speed text not null default 'standard'",
  ],
  jobs: [
    "id text not null pk",
    "job_set_id text not null",
    "idx integer not null",
    "provider_job_id text",
    "idempotency_key text",
    "status text not null default 'pending'",
    "progress real",
    "seed integer",
    "attempt integer not null default 0",
    "next_attempt_at text",
    "error_code text",
    "error_message text",
    "latency_ms integer",
    "created_at text not null",
    "updated_at text not null",
    "started_at text",
    "finished_at text",
    "error_reason text",
    "speed_used text",
    "error_action text",
    "handle text",
    "resumable integer not null default 0",
    "resumed_at text",
    "rerun_at text",
  ],
  provider_batches: [
    "id text not null pk",
    "job_set_id text not null",
    "provider_id text not null",
    "model_id text not null",
    "remote_id text",
    "display_name text not null",
    "state text not null default 'submitting'",
    "handle text",
    "item_count integer not null",
    "credential_hint text",
    "submitted_at text",
    "expires_at text",
    "last_polled_at text",
    "next_poll_at text",
    "finished_at text",
    "notified_at text",
    "cleaned_at text",
    "error_code text",
    "error_message text",
    "created_at text not null",
    "updated_at text not null",
  ],
  assets: [
    "id text not null pk",
    "kind text not null",
    "modality text not null default 'image'",
    "job_id text",
    "job_set_id text",
    "path text not null",
    "mime text not null",
    "width integer not null",
    "height integer not null",
    "bytes integer not null",
    "sha256 text not null",
    "seed integer",
    "provider_id text",
    "model_id text",
    "prompt text not null default ''",
    "params text",
    "tags text not null default ''",
    "cost_usd real",
    "parent_asset_id text",
    "root_asset_id text not null",
    "op text",
    "op_params text",
    "mask_asset_id text",
    "generative integer not null default 1",
    "approximate integer not null default 0",
    "approximate_reason text",
    "file_state text not null default 'ok'",
    "created_at text not null",
    "updated_at text not null",
    "deleted_at text",
  ],
  asset_edges: [
    "parent_asset_id text not null pk1",
    "child_asset_id text not null pk2",
    "relation text not null pk3",
    "ordinal integer not null default 0 pk4",
    "created_at text not null",
  ],
  folders: [
    "id text not null pk",
    "parent_id text",
    "name text not null",
    "color text",
    "sort_order integer not null default 0",
    "created_at text not null",
    "updated_at text not null",
  ],
  asset_folders: ["asset_id text not null pk1", "folder_id text not null pk2", "added_at text not null"],
  favourites: ["asset_id text not null pk", "created_at text not null"],
  presets: [
    "id text not null pk",
    "name text not null",
    "description text",
    "payload_json text not null",
    "thumb_asset_id text",
    "builtin integer not null default 0",
    "origin text",
    "sort_order integer not null default 0",
    "created_at text not null",
    "updated_at text not null",
  ],
  preset_assets: [
    "preset_id text not null pk1",
    "asset_id text not null pk2",
    "role text not null pk3",
    "weight real not null default 1",
    "ordinal integer not null default 0",
  ],
  reference_sets: [
    "id text not null pk",
    "name text not null",
    "created_at text not null",
    "updated_at text not null",
  ],
  reference_set_items: [
    "set_id text not null pk1",
    "asset_id text not null pk2",
    "position integer not null",
    "weight real not null default 1",
    "role text not null",
  ],
  characters: [
    "id text not null pk",
    "name text not null",
    "descriptor text",
    "reference_set_id text",
    "seed integer",
    "lock_seed integer not null default 0",
    "injection text",
    "token text",
    "provider_identity_json text",
    "thumb_asset_id text",
    "created_at text not null",
    "updated_at text not null",
  ],
  character_assets: [
    "character_id text not null pk1",
    "asset_id text not null pk2",
    "ordinal integer not null default 0",
  ],
  palettes: [
    "id text not null pk",
    "name text not null",
    "hex_json text not null",
    "populations_json text not null",
    "source_asset_id text",
    "k integer not null",
    "mode text not null",
    "builtin integer not null default 0",
    "created_at text not null",
    "updated_at text not null",
  ],
  saved_prompts: [
    "id text not null pk",
    "name text not null",
    "text text not null",
    "tags_json text",
    "preset_id text",
    "created_at text not null",
    "updated_at text not null",
  ],
  canvases: [
    "id text not null pk",
    "name text not null default 'Untitled'",
    "graph text not null",
    "graph_version integer not null default 1",
    "schema_version integer not null default 1",
    "preview_path text",
    "created_at text not null",
    "updated_at text not null",
    "opened_at text",
    "deleted_at text",
    "node_count integer not null default 0",
    "cover_asset_id text",
    "folder_id text",
  ],
  canvas_versions: [
    "id text not null pk",
    "canvas_id text not null",
    "graph text not null",
    "label text",
    "created_at text not null",
    "kind text not null default 'auto'",
    "node_count integer not null default 0",
    "edge_count integer not null default 0",
    "cover_asset_id text",
  ],
  canvas_runs: [
    "id text not null pk",
    "canvas_id text not null",
    "scope text not null",
    "status text not null default 'running'",
    "created_at text not null",
    "finished_at text",
    "plan text not null default '{}'",
    "nodes text not null default '[]'",
    "priority integer not null default 10",
  ],
  usage_log: [
    "id integer not null pk",
    "ts text not null",
    "provider_id text not null",
    "model_id text not null",
    "job_set_id text",
    "job_id text",
    "batch_index integer",
    "operation text not null",
    "outcome text not null",
    "size text",
    "quality text",
    "units text",
    "estimate_min real",
    "estimate_max real",
    "cost_usd real",
    "cost_source text",
    "price_as_of text",
    "discarded integer not null default 0",
    "latency_ms integer",
    "http_status integer",
    "speed text",
    "simulated integer not null default 0",
    "rerun integer not null default 0",
  ],
  settings: ["key text not null pk", "value text not null", "updated_at text not null"],
};

// §8.2.1 verbatim, plus the two unique indexes Drizzle names itself (§8.2 conventions).
const INDEXES = `
CREATE INDEX idx_assets_feed        ON assets(created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_modality    ON assets(modality, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_model       ON assets(model_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_job_set     ON assets(job_set_id);
CREATE INDEX idx_assets_sha256      ON assets(sha256);
CREATE INDEX idx_assets_trash       ON assets(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_assets_root        ON assets(root_asset_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_asset_folders_fld  ON asset_folders(folder_id, added_at DESC);
CREATE INDEX idx_favourites_created ON favourites(created_at DESC);
CREATE INDEX idx_edges_parent       ON asset_edges(parent_asset_id);
CREATE INDEX idx_edges_child        ON asset_edges(child_asset_id);
CREATE INDEX idx_jobs_active        ON jobs(status, next_attempt_at)
  WHERE status IN ('pending','submitting','queued','running');
CREATE INDEX idx_jobs_job_set       ON jobs(job_set_id, idx);
CREATE INDEX idx_job_sets_created   ON job_sets(created_at DESC);
CREATE INDEX idx_job_sets_sched     ON job_sets(priority DESC, created_at)
  WHERE status IN ('pending','submitting','queued','running');
CREATE INDEX idx_job_sets_canvas    ON job_sets(canvas_id, canvas_node_id);
CREATE INDEX idx_job_sets_run       ON job_sets(canvas_run_id);
CREATE INDEX idx_provider_batches_active ON provider_batches(state, next_poll_at)
  WHERE state IN ('submitting','queued','running');
CREATE INDEX idx_ref_set_items      ON reference_set_items(set_id, position);
CREATE INDEX idx_usage_ts           ON usage_log(ts DESC);
CREATE INDEX idx_usage_model        ON usage_log(provider_id, model_id, ts DESC);
CREATE INDEX idx_canvas_versions    ON canvas_versions(canvas_id, created_at DESC);
CREATE UNIQUE INDEX job_sets_idempotency_key_unique ON job_sets(idempotency_key);
CREATE UNIQUE INDEX jobs_job_set_id_idx_unique ON jobs(job_set_id, idx);
CREATE UNIQUE INDEX provider_batches_job_set_id_unique ON provider_batches(job_set_id);
`;

// name -> the list its IN (...) must equal, or the exact expression.
const CHECKS: Record<string, [string, readonly string[]] | string> = {
  providers_auth_kind_check: ["auth_kind", AUTH_KINDS],
  providers_credential_source_check: ["credential_source", CREDENTIAL_SOURCES],
  models_modality_check: ["modality", MODALITIES],
  models_source_check: ["source", MODEL_SOURCES],
  job_sets_op_check: ["op", OPS],
  job_sets_batch_size_check: "batch_size BETWEEN 1 AND 4",
  job_sets_status_check: ["status", JOB_SET_STATES],
  job_sets_source_check: ["source", JOB_SOURCES],
  job_sets_speed_check: ["speed", SPEED_IDS],
  jobs_status_check: ["status", JOB_STATES],
  jobs_speed_used_check: ["speed_used", SPEED_IDS],
  provider_batches_state_check: ["state", BATCH_STATES],
  assets_kind_check: ["kind", ASSET_KINDS],
  assets_file_state_check: ["file_state", FILE_STATES],
  asset_edges_relation_check: ["relation", EDGE_RELATIONS],
  preset_assets_role_check: ["role", PRESET_ASSET_ROLES],
  reference_set_items_role_check: ["role", REFERENCE_SET_ROLES],
  characters_injection_check: ["injection", CHARACTER_INJECTIONS],
  palettes_mode_check: ["mode", PALETTE_MODES],
  canvas_versions_kind_check: ["kind", CANVAS_VERSION_KINDS],
  canvas_runs_scope_check: ["scope", CANVAS_RUN_SCOPES],
  canvas_runs_status_check: ["status", JOB_SET_STATES],
  usage_log_outcome_check: ["outcome", USAGE_OUTCOMES],
  usage_log_cost_source_check: ["cost_source", COST_SOURCES],
  usage_log_speed_check: ["speed", SPEED_IDS],
};

// table -> "from -> parent.to on delete <action>". Lineage parents deliberately have none (§0.7).
const FOREIGN_KEYS: Record<string, string[]> = {
  providers: [],
  models: ["provider_id -> providers.id on delete cascade"],
  job_sets: [
    "canvas_id -> canvases.id on delete set null",
    "canvas_run_id -> canvas_runs.id on delete set null",
    "provider_id -> providers.id on delete no action",
  ],
  jobs: ["job_set_id -> job_sets.id on delete cascade"],
  provider_batches: [
    "job_set_id -> job_sets.id on delete cascade",
    "provider_id -> providers.id on delete no action",
  ],
  assets: [
    "job_id -> jobs.id on delete set null",
    "job_set_id -> job_sets.id on delete set null",
    "mask_asset_id -> assets.id on delete set null",
  ],
  asset_edges: ["child_asset_id -> assets.id on delete cascade"],
  folders: ["parent_id -> folders.id on delete cascade"],
  asset_folders: ["asset_id -> assets.id on delete cascade", "folder_id -> folders.id on delete cascade"],
  favourites: ["asset_id -> assets.id on delete cascade"],
  presets: ["thumb_asset_id -> assets.id on delete set null"],
  preset_assets: ["asset_id -> assets.id on delete cascade", "preset_id -> presets.id on delete cascade"],
  reference_sets: [],
  reference_set_items: [
    "asset_id -> assets.id on delete cascade",
    "set_id -> reference_sets.id on delete cascade",
  ],
  characters: [
    "reference_set_id -> reference_sets.id on delete no action",
    "thumb_asset_id -> assets.id on delete set null",
  ],
  character_assets: [
    "asset_id -> assets.id on delete cascade",
    "character_id -> characters.id on delete cascade",
  ],
  palettes: ["source_asset_id -> assets.id on delete set null"],
  saved_prompts: ["preset_id -> presets.id on delete set null"],
  canvases: ["folder_id -> folders.id on delete set null"],
  canvas_versions: ["canvas_id -> canvases.id on delete cascade"],
  canvas_runs: ["canvas_id -> canvases.id on delete cascade"],
  usage_log: [],
  settings: [],
};

// §8.2.3 verbatim.
const FTS_OBJECTS = {
  assets_fts: `CREATE VIRTUAL TABLE assets_fts USING fts5(prompt, model_id UNINDEXED, tags, content = 'assets',
    content_rowid = 'rowid', tokenize = "unicode61 remove_diacritics 2")`,
  assets_ai: `CREATE TRIGGER assets_ai AFTER INSERT ON assets BEGIN
    INSERT INTO assets_fts(rowid, prompt, model_id, tags) VALUES (new.rowid, new.prompt, new.model_id, new.tags);
    END`,
  assets_ad: `CREATE TRIGGER assets_ad AFTER DELETE ON assets BEGIN
    INSERT INTO assets_fts(assets_fts, rowid, prompt, model_id, tags)
    VALUES ('delete', old.rowid, old.prompt, old.model_id, old.tags);
    END`,
  assets_au: `CREATE TRIGGER assets_au AFTER UPDATE OF prompt, model_id, tags ON assets BEGIN
    INSERT INTO assets_fts(assets_fts, rowid, prompt, model_id, tags)
    VALUES ('delete', old.rowid, old.prompt, old.model_id, old.tags);
    INSERT INTO assets_fts(rowid, prompt, model_id, tags) VALUES (new.rowid, new.prompt, new.model_id, new.tags);
    END`,
};

describe("tables and columns", () => {
  test("every §8.2 table exists, and nothing else outside SQLite and FTS internals", () => {
    const tables = master("table")
      .map((t) => t.name)
      .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("assets_fts") && n !== "__drizzle_migrations");
    expect(tables.sort()).toEqual(Object.keys(COLUMNS).sort());
  });

  for (const [table, expected] of Object.entries(COLUMNS)) {
    test(`${table} columns`, () => {
      const cols = raw.query(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      const composite = cols.filter((c) => c.pk > 0).length > 1;
      const actual = cols.map(
        (c) =>
          `${c.name} ${c.type.toLowerCase()}${c.notnull ? " not null" : ""}` +
          `${c.dflt_value !== null ? ` default ${c.dflt_value}` : ""}` +
          `${c.pk ? ` pk${composite ? c.pk : ""}` : ""}`,
      );
      expect(actual).toEqual(expected);
    });
  }

  test("no table is WITHOUT ROWID, so assets keeps the rowid search depends on", () => {
    for (const t of master("table").filter((t) => t.name in COLUMNS)) {
      expect(t.sql ?? "").not.toMatch(/without rowid/i);
    }
  });

  test("the Drizzle schema and the migrations agree", () => {
    const tables = Object.values(schema as Record<string, unknown>).filter(
      (v): v is SQLiteTable => v instanceof SQLiteTable,
    );
    expect(tables.length).toBe(Object.keys(COLUMNS).length);
    const dbIndexes = master("index").filter((i) => i.sql !== null);
    for (const table of tables) {
      const config = getTableConfig(table);
      const cols = (raw.query(`PRAGMA table_info(${config.name})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(config.columns.map((c) => c.name).sort()).toEqual(cols.sort());
      const declared = [
        ...config.indexes.map((i) => i.config.name),
        ...config.uniqueConstraints.map((u) => u.name),
        ...config.columns.filter((c) => c.isUnique).map((c) => `${config.name}_${c.name}_unique`),
      ];
      const migrated = dbIndexes.filter((i) => i.tbl_name === config.name).map((i) => i.name);
      expect(declared.sort()).toEqual(migrated.sort());
    }
  });
});

describe("indices (§8.2.1)", () => {
  const expected = INDEXES.split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(norm);

  test("each index matches the spec statement", () => {
    const actual = master("index")
      .filter((i) => i.sql !== null)
      .map((i) => norm(i.sql!));
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("the feed query uses the partial feed index", () => {
    const plan = raw
      .query(
        `EXPLAIN QUERY PLAN SELECT id FROM assets WHERE deleted_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_assets_feed");
  });
});

describe("CHECK constraints", () => {
  const checks = new Map<string, string>();
  beforeAll(() => {
    for (const t of master("table")) {
      for (const m of (t.sql ?? "").matchAll(/CONSTRAINT\s+"([^"]+)"\s+CHECK\((.+?)\),?\s*$/gm)) {
        checks.set(m[1]!, m[2]!);
      }
    }
  });

  test("exactly the named CHECKs of §8.2, and no 0/1 CHECK on flags", () => {
    expect([...checks.keys()].sort()).toEqual(Object.keys(CHECKS).sort());
  });

  for (const [name, spec] of Object.entries(CHECKS)) {
    test(`${name} is built from its core constant`, () => {
      const body = checks.get(name);
      if (typeof spec === "string") {
        expect(body).toBe(spec);
        return;
      }
      const [column, values] = spec;
      const m = /^(\w+) IN \((.*)\)$/.exec(body ?? "");
      expect(m?.[1]).toBe(column);
      expect(m?.[2]?.split(",").map((v) => v.replace(/^'|'$/g, ""))).toEqual([...values]);
    });
  }

  test("the database rejects values outside the lists", () => {
    const at = "2026-09-23T00:00:00.000Z";
    raw.run(
      "INSERT INTO providers (id, display_name, adapter, auth_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["checks", "Checks", "checks", "api_key", at, at],
    );
    const jobSet = (status: string, batch: number) =>
      raw.run(
        `INSERT INTO job_sets (id, op, provider_id, model_id, request_json, batch_size, status, created_at)
         VALUES (?, 'generate', 'checks', 'm', '{}', ?, ?, ?)`,
        [crypto.randomUUID(), batch, status, at],
      );
    expect(() => jobSet("submitted", 1)).toThrow(/CHECK constraint failed/);
    expect(() => jobSet("pending", 5)).toThrow(/CHECK constraint failed/);
    expect(() => jobSet("pending", 0)).toThrow(/CHECK constraint failed/);
    expect(() => jobSet("partial", 4)).not.toThrow();
    raw.run("DELETE FROM job_sets WHERE provider_id = 'checks'");
    raw.run("DELETE FROM providers WHERE id = 'checks'");
  });
});

describe("foreign keys", () => {
  for (const [table, expected] of Object.entries(FOREIGN_KEYS)) {
    test(`${table} references`, () => {
      const fks = raw.query(`PRAGMA foreign_key_list(${table})`).all() as {
        from: string;
        table: string;
        to: string;
        on_delete: string;
      }[];
      const actual = fks.map((f) => `${f.from} -> ${f.table}.${f.to} on delete ${f.on_delete.toLowerCase()}`);
      expect(actual.sort()).toEqual([...expected].sort());
    });
  }

  test("foreign_key_check is clean and enforcement is on after boot", () => {
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() =>
      raw.run(
        "INSERT INTO jobs (id, job_set_id, idx, created_at, updated_at) VALUES ('orphan', 'nope', 0, 'x', 'x')",
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("boot (§8.2.4)", () => {
  test("PRAGMAs are set", () => {
    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(raw.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    expect(raw.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  test("every migration is in the journal and applied, newest tag reported", () => {
    expect(opened.schemaTag).toBe("0006_canvas");
    expect(raw.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 7 });
  });

  test("reopening applies nothing twice", () => {
    const again = openDb(file);
    expect(again.schemaTag).toBe("0006_canvas");
    expect(again.db.$client.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 7 });
    again.close();
  });

  test("0003 to 0006 keep existing rows: Standard runs, real spend, no settings, no restarts, canvases", () => {
    // A library last opened at 0002, with a run and its usage row in it.
    const folder = join(dir, "migrations-0002");
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag < "0003");
    writeFileSync(journalPath, JSON.stringify(journal));

    const path = join(dir, "upgrade.db");
    const old = new Database(path, { create: true });
    old.run("PRAGMA foreign_keys = OFF");
    migrate(drizzle({ client: old }), { migrationsFolder: folder });
    const at = "2026-09-20T10:00:00.000Z";
    old.run(
      `INSERT INTO providers (id, display_name, adapter, auth_kind, concurrency_cap, created_at, updated_at)
       VALUES ('google', 'Google', 'google', 'api_key', 3, ?, ?)`,
      [at, at],
    );
    old.run(
      `INSERT INTO canvases (id, name, graph, created_at, updated_at) VALUES ('cv1', 'Old', '{"nodes":[],"edges":[]}', ?, ?)`,
      [at, at],
    );
    old.run(
      `INSERT INTO canvas_versions (id, canvas_id, graph, label, created_at)
       VALUES ('ver1', 'cv1', '{"nodes":[],"edges":[]}', 'autosave', ?)`,
      [at],
    );
    old.run(
      `INSERT INTO canvas_runs (id, canvas_id, scope, status, created_at) VALUES ('run1', 'cv1', 'all', 'succeeded', ?)`,
      [at],
    );
    old.run(
      `INSERT INTO job_sets (id, op, provider_id, model_id, request_json, batch_size, status, created_at, cost_actual_usd, canvas_id, canvas_run_id)
       VALUES ('set1', 'generate', 'google', 'gemini-3-pro-image', '{"batch":1}', 1, 'succeeded', ?, 0.134, 'cv1', 'run1')`,
      [at],
    );
    old.run(
      `INSERT INTO jobs (id, job_set_id, idx, status, created_at, updated_at, error_reason)
       VALUES ('job1', 'set1', 0, 'succeeded', ?, ?, NULL)`,
      [at, at],
    );
    old.run(
      `INSERT INTO usage_log (ts, provider_id, model_id, job_set_id, job_id, operation, outcome, cost_usd, discarded)
       VALUES (?, 'google', 'gemini-3-pro-image', 'set1', 'job1', 'generate', 'succeeded', 0.134, 0)`,
      [at],
    );
    old.close();

    const upgraded = openDb(path);
    const db = upgraded.db.$client;
    expect(upgraded.schemaTag).toBe("0006_canvas");
    expect(db.query("SELECT speed, cost_actual_usd, request_json FROM job_sets").get()).toEqual({
      speed: "standard",
      cost_actual_usd: 0.134,
      request_json: '{"batch":1}',
    });
    expect(db.query("SELECT status, speed_used FROM jobs").get()).toEqual({
      status: "succeeded",
      speed_used: null,
    });
    // Every call made before 0005 couldn't resume and never ran again.
    expect(db.query("SELECT handle, resumable, resumed_at, rerun_at FROM jobs").get()).toEqual({
      handle: null,
      resumable: 0,
      resumed_at: null,
      rerun_at: null,
    });
    expect(db.query("SELECT cost_usd, speed, simulated, rerun FROM usage_log").get()).toEqual({
      cost_usd: 0.134,
      speed: null,
      simulated: 0,
      rerun: 0,
    });
    expect(db.query("SELECT settings, concurrency_cap FROM providers").get()).toEqual({
      settings: null,
      concurrency_cap: 3,
    });
    // 0006 rebuilds canvas_versions: old versions become auto ones with no counts yet.
    expect(
      db.query("SELECT id, label, kind, node_count, edge_count, cover_asset_id FROM canvas_versions").get(),
    ).toEqual({
      id: "ver1",
      label: "autosave",
      kind: "auto",
      node_count: 0,
      edge_count: 0,
      cover_asset_id: null,
    });
    expect(db.query("SELECT node_count, cover_asset_id, folder_id FROM canvases").get()).toEqual({
      node_count: 0,
      cover_asset_id: null,
      folder_id: null,
    });
    expect(db.query("SELECT plan, nodes, priority FROM canvas_runs").get()).toEqual({
      plan: "{}",
      nodes: "[]",
      priority: 10,
    });
    expect(db.query("SELECT canvas_id, canvas_run_id FROM job_sets").get()).toEqual({
      canvas_id: "cv1",
      canvas_run_id: "run1",
    });
    // The rebuilt tables keep their indexes and their links to each other.
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'idx_canvas_versions'").get()).toEqual({
      name: "idx_canvas_versions",
    });
    expect(() => db.run("DELETE FROM job_sets WHERE id = 'set1'")).not.toThrow();
    expect(db.query("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    upgraded.close();
  });

  test("a library that ran the canvas migration as 0003 before the merge catches up", () => {
    // 0000 to 0002, then today's 0006_canvas file under the stamp it had as 0003_canvas.
    const folder = join(dir, "migrations-early-canvas");
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag < "0003");
    writeFileSync(journalPath, JSON.stringify(journal));

    const path = join(dir, "early-canvas.db");
    const old = new Database(path, { create: true });
    old.run("PRAGMA foreign_keys = OFF");
    migrate(drizzle({ client: old }), { migrationsFolder: folder });
    const tags = (
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
        entries: { tag: string }[];
      }
    ).entries.map((e) => e.tag);
    const canvas = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })[tags.indexOf("0006_canvas")]!;
    for (const statement of canvas.sql) old.run(statement);
    old.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
      canvas.hash,
      1790185934361,
    ]);
    const at = "2026-09-20T10:00:00.000Z";
    old.run(
      `INSERT INTO canvases (id, name, graph, node_count, created_at, updated_at)
       VALUES ('cv1', 'Mine', '{"nodes":[],"edges":[]}', 3, ?, ?)`,
      [at, at],
    );
    old.close();

    const upgraded = openDb(path);
    const db = upgraded.db.$client;
    expect(upgraded.schemaTag).toBe("0006_canvas");
    expect(db.query("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({ n: 7 });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'provider_batches'").get()).toEqual({
      name: "provider_batches",
    });
    expect(
      db.query("SELECT count(*) AS n FROM pragma_table_info('jobs') WHERE name = 'handle'").get(),
    ).toEqual({
      n: 1,
    });
    expect(db.query("SELECT name, node_count FROM canvases").get()).toEqual({ name: "Mine", node_count: 3 });
    upgraded.close();
    // And the next boot has nothing left to do.
    const again = openDb(path);
    expect(again.schemaTag).toBe("0006_canvas");
    again.close();
  });

  test("a failing migration rolls back and names the file", () => {
    const path = join(dir, "broken.db");
    const pre = new Database(path, { create: true });
    pre.run("CREATE TABLE assets_fts (x)"); // collides with 0001
    pre.close();
    let error: unknown;
    try {
      openDb(path);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).migration).toBe("0001_assets_fts");
    expect((error as MigrationError).message).toContain("0001_assets_fts");
    const after = new Database(path);
    expect(after.query("SELECT name FROM sqlite_master WHERE name = 'assets'").get()).toBeNull();
    after.close();
  });

  test("rows pointing at nothing stop the boot", () => {
    const path = join(dir, "orphans.db");
    openDb(path).close();
    const pre = new Database(path);
    pre.run("PRAGMA foreign_keys = OFF");
    pre.run(
      "INSERT INTO jobs (id, job_set_id, idx, created_at, updated_at) VALUES ('j', 'missing', 0, 'x', 'x')",
    );
    pre.close();
    expect(() => openDb(path)).toThrow(MigrationIntegrityError);
  });
});

describe("search (§8.2.3)", () => {
  const at = (n: number) => `2026-09-23T10:00:${String(n).padStart(2, "0")}.000Z`;
  const add = (id: string, prompt: string, n: number, tags = "") =>
    insertAsset(opened.db, {
      id,
      kind: "generated",
      path: `assets/2026/09/23/${id}.png`,
      mime: "image/png",
      width: 1024,
      height: 1280,
      bytes: 1000,
      sha256: "a".repeat(64),
      modelId: "gemini-3-pro-image",
      prompt,
      tags,
      createdAt: at(n),
    });

  test("the FTS objects match the spec", () => {
    for (const [name, sql] of Object.entries(FTS_OBJECTS)) {
      const row = raw.query("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as {
        sql: string;
      } | null;
      expect(norm(row?.sql ?? "")).toBe(norm(sql));
    }
  });

  test("prompts and tags are searchable, soft delete keeps the row, hard delete removes it", () => {
    add("S1", "A lighthouse on a cliff at dusk, café lights", 1);
    add("S2", "Portrait of a fox in the snow", 2, "winter animals");
    add("S3", "Foxglove flowers in a meadow", 3);

    const fox = searchAssets(opened.db, { text: "fox" }).items.map((a) => a.id);
    expect(fox).toEqual(["S3", "S2"]); // prefix match on the last word, newest first
    expect(searchAssets(opened.db, { text: "fox snow" }).items.map((a) => a.id)).toEqual(["S2"]);
    expect(searchAssets(opened.db, { text: "winter" }).items.map((a) => a.id)).toEqual(["S2"]);
    expect(searchAssets(opened.db, { text: "cafe" }).items.map((a) => a.id)).toEqual(["S1"]); // diacritics folded
    expect(searchAssets(opened.db, { text: "snow" }).items[0]?.excerpt).toContain("<mark>snow</mark>");
    // FTS syntax is plain text, never an error.
    expect(searchAssets(opened.db, { text: 'NEAR( "fox AND * -' }).items).toEqual([]);
    expect(searchAssets(opened.db, { text: "   " }).items).toEqual([]);

    const ftsRows = () => (raw.query("SELECT count(*) AS n FROM assets_fts").get() as { n: number }).n;
    const before = ftsRows();
    softDeleteAssets(opened.db, ["S2"]);
    expect(ftsRows()).toBe(before);
    expect(searchAssets(opened.db, { text: "snow" }).items).toEqual([]);

    updateAssetTags(opened.db, "S3", "garden");
    expect(searchAssets(opened.db, { text: "garden" }).items.map((a) => a.id)).toEqual(["S3"]);

    hardDeleteAsset(opened.db, "S2");
    expect(ftsRows()).toBe(before - 1);

    rebuildSearchIndex(opened.db);
    expect(searchAssets(opened.db, { text: "lighthouse" }).items.map((a) => a.id)).toEqual(["S1"]);
    for (const id of ["S1", "S3"]) hardDeleteAsset(opened.db, id);
  });
  test("the index is rebuilt once when the database file changes, and not again", () => {
    add("R1", "A red kite over the hills", 4);
    // An index that lost its rows, as a restored backup's can.
    raw.run("INSERT INTO assets_fts(assets_fts) VALUES('delete-all')");
    expect(searchAssets(opened.db, { text: "kite" }).items).toEqual([]);

    expect(rebuildSearchIndexIfReplaced(opened.db, "111").rebuilt).toBe(true);
    expect(searchAssets(opened.db, { text: "kite" }).items.map((a) => a.id)).toEqual(["R1"]);
    expect(rebuildSearchIndexIfReplaced(opened.db, "111")).toEqual({ rebuilt: false, previous: "111" });
    expect(rebuildSearchIndexIfReplaced(opened.db, "222")).toEqual({ rebuilt: true, previous: "111" });
    // The marker isn't a setting, so it never shows up among them.
    expect(Object.keys(readSettings(opened.db))).not.toContain("internal.dbFile");
    hardDeleteAsset(opened.db, "R1");
  });
});

describe("feed pagination (§8.2.2)", () => {
  // A database of its own: rows other tests add (in any order) would change what the pages hold.
  let feedDir: string;
  let feed: OpenDb;
  beforeAll(() => {
    feedDir = mkdtempSync(join(tmpdir(), "openfield-feed-"));
    feed = openDb(join(feedDir, "openfield.db"));
  });
  afterAll(() => {
    feed.close();
    rmSync(feedDir, { recursive: true, force: true });
  });

  test("pages are newest first, stable across ties and unaffected by new rows", () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const id = `P${String(i).padStart(3, "0")}`;
      ids.push(id);
      insertAsset(feed.db, {
        id,
        kind: "generated",
        path: `assets/${id}.png`,
        mime: "image/png",
        width: 1024,
        height: 1024,
        bytes: 1,
        sha256: "b".repeat(64),
        // Ten rows per timestamp, so the id tiebreak matters.
        createdAt: `2026-09-23T11:00:${String(Math.floor(i / 10)).padStart(2, "0")}.000Z`,
      });
    }
    const expected = feed.db.$client
      .query("SELECT id FROM assets WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC")
      .all()
      .map((r) => (r as { id: string }).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = feedPage(feed.db, { cursor });
      expect(page.items.length).toBeLessThanOrEqual(50);
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
      if (pages++ === 0) {
        // A newer image arriving mid-scroll must not shift later pages.
        insertAsset(feed.db, {
          id: "P999",
          kind: "generated",
          path: "assets/P999.png",
          mime: "image/png",
          width: 1,
          height: 1,
          bytes: 1,
          sha256: "c".repeat(64),
          createdAt: "2026-09-23T12:00:00.000Z",
        });
      }
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect(feedPage(feed.db).items[0]?.id).toBe("P999");
  });
});

describe("flags", () => {
  test("booleans round-trip as 0/1 on disk", () => {
    const row = insertAsset(opened.db, {
      id: "B1",
      kind: "edited",
      path: "assets/B1.png",
      mime: "image/png",
      width: 1,
      height: 1,
      bytes: 1,
      sha256: "d".repeat(64),
      generative: false,
      approximate: true,
      approximateReason: "regional",
    });
    expect(row.generative).toBe(false);
    expect(row.approximate).toBe(true);
    expect(raw.query("SELECT generative, approximate FROM assets WHERE id = 'B1'").get()).toEqual({
      generative: 0,
      approximate: 1,
    });
    const defaults = insertAsset(opened.db, {
      id: "B2",
      kind: "generated",
      path: "assets/B2.png",
      mime: "image/png",
      width: 1,
      height: 1,
      bytes: 1,
      sha256: "e".repeat(64),
    });
    expect(defaults.generative).toBe(true);
    expect(defaults.approximate).toBe(false);
    expect(getAsset(opened.db, "B1")?.approximate).toBe(true);
  });
});
