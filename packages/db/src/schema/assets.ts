import { ASSET_KINDS, EDGE_RELATIONS, FILE_STATES, OPS } from "@openfield/core/constants";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { flag, json, oneOf } from "./_helpers";
import { jobSets, jobs } from "./jobs";

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ASSET_KINDS }).notNull(),
    modality: text("modality").notNull().default("image"),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    jobSetId: text("job_set_id").references(() => jobSets.id, { onDelete: "set null" }),
    path: text("path").notNull(), // relative to OPENFIELD_HOME, never absolute (§0.2)
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    seed: integer("seed"),
    providerId: text("provider_id"), // 'local' for crop, grade and overlay, so no FK
    modelId: text("model_id"), // denormalised: the feed filters on it constantly
    prompt: text("prompt").notNull().default(""), // denormalised for search and the Info tab
    params: json<Record<string, unknown>>("params"),
    tags: text("tags").notNull().default(""), // space-separated, indexed by search
    costUsd: real("cost_usd"),
    // Lineage (§0.7). The version strip and History read these, never a recursive query.
    // No FK on the parent: a hard-deleted parent leaves the child's chain as a tombstone.
    parentAssetId: text("parent_asset_id"),
    rootAssetId: text("root_asset_id").notNull(),
    op: text("op", { enum: OPS }),
    opParams: json<Record<string, unknown>>("op_params"),
    maskAssetId: text("mask_asset_id").references((): AnySQLiteColumn => assets.id, { onDelete: "set null" }),
    generative: flag("generative", 1), // 0 for local ops
    approximate: flag("approximate", 0), // 1 when made by the regional fallback (§0.9)
    approximateReason: text("approximate_reason"),
    fileState: text("file_state", { enum: FILE_STATES }).notNull().default("ok"),
    // Videos only (0008): how long it runs, whether it has sound, and its poster frame, a JPEG the
    // thumbnails are made from. Null on images.
    durationMs: integer("duration_ms"),
    hasAudio: integer("has_audio", { mode: "boolean" }),
    posterPath: text("poster_path"), // relative to OPENFIELD_HOME, like path

    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"), // soft delete: in the trash
  },
  (t) => [
    check("assets_kind_check", oneOf("kind", ASSET_KINDS)),
    check("assets_file_state_check", oneOf("file_state", FILE_STATES)),
    // Feed: keyset pagination over the live library, newest first.
    index("idx_assets_feed").on(sql`created_at DESC`, sql`id DESC`).where(sql`deleted_at IS NULL`),
    index("idx_assets_modality").on(t.modality, sql`created_at DESC`).where(sql`deleted_at IS NULL`),
    index("idx_assets_model").on(t.modelId, sql`created_at DESC`).where(sql`deleted_at IS NULL`),
    index("idx_assets_job_set").on(t.jobSetId),
    index("idx_assets_sha256").on(t.sha256),
    index("idx_assets_trash").on(t.deletedAt).where(sql`deleted_at IS NOT NULL`),
    // Version strip and History: one index scan per lineage root (§0.7).
    index("idx_assets_root").on(t.rootAssetId, t.createdAt).where(sql`deleted_at IS NULL`),
  ],
);

// The multi-parent reference graph only. The operation lives on assets.op, never on the edge.
export const assetEdges = sqliteTable(
  "asset_edges",
  {
    parentAssetId: text("parent_asset_id").notNull(), // no FK: survives a hard-deleted parent
    childAssetId: text("child_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    relation: text("relation", { enum: EDGE_RELATIONS }).notNull(),
    ordinal: integer("ordinal").notNull().default(0), // reference order, as in the Info tab
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.parentAssetId, t.childAssetId, t.relation, t.ordinal] }),
    check("asset_edges_relation_check", oneOf("relation", EDGE_RELATIONS)),
    index("idx_edges_parent").on(t.parentAssetId),
    index("idx_edges_child").on(t.childAssetId),
  ],
);
