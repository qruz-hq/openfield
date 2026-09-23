import type { CanvasGraph } from "@openfield/core/canvas";
import { CANVAS_RUN_SCOPES, JOB_SET_STATES } from "@openfield/core/constants";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, oneOf } from "./_helpers";

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
});

export const canvasVersions = sqliteTable(
  "canvas_versions",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    graph: json<CanvasGraph>("graph").notNull(),
    label: text("label"), // 'autosave' or a name the person typed
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_canvas_versions").on(t.canvasId, sql`created_at DESC`)],
);

// One row per canvas run, so a multi-node run survives a reload (§0.12, §7.7).
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
  },
  () => [
    check("canvas_runs_scope_check", oneOf("scope", CANVAS_RUN_SCOPES)),
    check("canvas_runs_status_check", oneOf("status", JOB_SET_STATES)),
  ],
);
