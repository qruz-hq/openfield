import { COST_SOURCES, OPS, SPEED_IDS, USAGE_OUTCOMES } from "@openfield/core/constants";
import type { UsageUnits } from "@openfield/core/schemas";
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { flag, json, oneOf } from "./_helpers";

// One row per terminal outcome: success, failure and cancel alike (§0.13).
// A failure costs 0 with cost_source 'unknown'; a cancel after submit is billed with discarded = 1.
export const usageLog = sqliteTable(
  "usage_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    jobSetId: text("job_set_id"),
    jobId: text("job_id"),
    batchIndex: integer("batch_index"),
    operation: text("operation", { enum: OPS }).notNull(),
    outcome: text("outcome", { enum: USAGE_OUTCOMES }).notNull(),
    size: text("size"), // '1536x2048'
    quality: text("quality"),
    units: json<UsageUnits>("units"),
    estimateMin: real("estimate_min"),
    estimateMax: real("estimate_max"),
    costUsd: real("cost_usd"),
    costSource: text("cost_source", { enum: COST_SOURCES }),
    priceAsOf: text("price_as_of"),
    discarded: flag("discarded", 0),
    latencyMs: integer("latency_ms"),
    httpStatus: integer("http_status"),
    speed: text("speed", { enum: SPEED_IDS }), // the speed billed (§0.13). Added in 0003
    simulated: flag("simulated", 0), // fake mode: cost 0, never in a spend total
  },
  (t) => [
    check("usage_log_outcome_check", oneOf("outcome", USAGE_OUTCOMES)),
    check("usage_log_cost_source_check", oneOf("cost_source", COST_SOURCES)),
    check("usage_log_speed_check", oneOf("speed", SPEED_IDS)),
    index("idx_usage_ts").on(sql`ts DESC`),
    index("idx_usage_model").on(t.providerId, t.modelId, sql`ts DESC`),
  ],
);

// One row per settings key; each value is JSON, validated by core's settingsSchema (§6.17).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
