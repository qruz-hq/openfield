import type { CanvasGraph, CanvasRunRecord } from "@openfield/core/canvas";
import { CANVAS_RUN_SCOPES, CANVAS_VERSION_KINDS, JOB_SET_STATES } from "@openfield/core/constants";
import type { CanvasRunNodeState } from "@openfield/core/schemas";
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, oneOf } from "./_helpers";
import { folders } from "./organisation";

export const canvases = sqliteTable("canvases", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("Untitled"),
  graph: json<CanvasGraph>("graph").notNull(), // the whole document, per canvasDocumentSchema
  graphVersion: integer("graph_version").notNull().default(1), // optimistic concurrency token
  schemaVersion: integer("schema_version").notNull().default(1), // document shape, for its migrations
  previewPath: text("preview_path"), // canvases/previews/<id>.png
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  openedAt: text("opened_at"),
  deletedAt: text("deleted_at"),
  // Added in 0006, so they sit last. Kept on save so the index never parses a graph.
  nodeCount: integer("node_count").notNull().default(0),
  coverAssetId: text("cover_asset_id"), // newest result image: the card's fallback preview
  // The library folder its images are filed into, named after the canvas (§7.1).
  folderId: text("folder_id").references((): AnySQLiteColumn => folders.id, { onDelete: "set null" }),
});

export const canvasVersions = sqliteTable(
  "canvas_versions",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    graph: json<CanvasGraph>("graph").notNull(),
    label: text("label"), // a name the person typed, or null
    createdAt: text("created_at").notNull(),
    // Added in 0006. auto versions are pruned to the newest 50; every other kind is kept (§7.8).
    kind: text("kind", { enum: CANVAS_VERSION_KINDS }).notNull().default("auto"),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    coverAssetId: text("cover_asset_id"),
  },
  (t) => [
    index("idx_canvas_versions").on(t.canvasId, sql`created_at DESC`),
    check("canvas_versions_kind_check", oneOf("kind", CANVAS_VERSION_KINDS)),
  ],
);

// One row per canvas run, so a multi-node run survives a reload and a restart (§0.12, §7.7).
export const canvasRuns = sqliteTable(
  "canvas_runs",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: CANVAS_RUN_SCOPES }).notNull(),
    status: text("status", { enum: JOB_SET_STATES }).notNull().default("running"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
    // Added in 0006. The plan as submitted plus launch bookkeeping, and the last node states sent.
    plan: json<CanvasRunRecord>("plan").notNull().default(sql`'{}'`),
    nodes: json<CanvasRunNodeState[]>("nodes").notNull().default(sql`'[]'`),
    priority: integer("priority").notNull().default(10), // single node 10, everything else 5 (§0.12)
  },
  () => [
    check("canvas_runs_scope_check", oneOf("scope", CANVAS_RUN_SCOPES)),
    check("canvas_runs_status_check", oneOf("status", JOB_SET_STATES)),
  ],
);
