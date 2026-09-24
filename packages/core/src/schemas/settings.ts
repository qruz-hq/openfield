import { z } from "zod";
import {
  BATCH_MAX,
  DEFAULT_FEED_ZOOM,
  ENHANCE_MODES,
  LOG_LEVELS,
  MAX_CONCURRENCY,
  MAX_FEED_ZOOM,
  THEMES,
  THUMB_ENGINES,
} from "../constants";
import { aspectRatioSchema, modelKeySchema, timestampSchema } from "./common";

// Every §6.17 key and its default. The settings table stores each key's JSON value.
// Secrets and boot-time values (keys, port, home) live in config.json, not here.

const settingValues = {
  /** Last model list check. Written by the server. */
  modelRefreshedAt: timestampSchema.nullable(),
  /** Up to a month between checks. */
  modelRefreshHours: z.int().min(1).max(720),
  /** null: the first model with a usable key. */
  defaultModel: modelKeySchema.nullable(),
  /** null: the model's own default. */
  defaultAspect: aspectRatioSchema.nullable(),
  defaultBatch: z.int().min(1).max(BATCH_MAX),
  globalConcurrency: z.int().min(1).max(MAX_CONCURRENCY),
  enhanceMode: z.enum(ENHANCE_MODES),
  enhancerModel: modelKeySchema.nullable(),
  regionalFallback: z.boolean(),
  theme: z.enum(THEMES),
  feedZoom: z.int().min(0).max(MAX_FEED_ZOOM),
  tipsCard: z.boolean(),
  thumbQuality: z.int().min(1).max(100),
  /** null: keep deleted images until the trash is emptied. */
  trashRetentionDays: z.int().min(1).max(3650).nullable(),
  /** Monthly soft limit in USD. null: off. */
  spendGuardUsd: z.number().positive().nullable(),
  logLevel: z.enum(LOG_LEVELS),
  showExperimental: z.boolean(),
  canvasFileWriteThrough: z.boolean(),
  upscaleCommandPath: z.string().min(1).max(4096).nullable(),
  /**
   * Send an image again at boot, once, when its call was cut off and can't resume (§0.4, §8.4.5).
   * Read once per boot. Never touches a call that resumes by id or a Batch run.
   */
  rerunInterrupted: z.boolean(),
};

type SettingValues = typeof settingValues;
export type Settings = { [K in keyof SettingValues]: z.output<SettingValues[K]> };
export type SettingKey = keyof Settings;

export const SETTINGS_DEFAULTS: Settings = {
  modelRefreshedAt: null,
  modelRefreshHours: 24,
  defaultModel: null,
  defaultAspect: null,
  defaultBatch: 1,
  globalConcurrency: 4,
  enhanceMode: "off",
  enhancerModel: null,
  regionalFallback: true,
  theme: "system",
  feedZoom: DEFAULT_FEED_ZOOM,
  tipsCard: true,
  thumbQuality: 82,
  trashRetentionDays: null,
  spendGuardUsd: null,
  logLevel: "info",
  showExperimental: false,
  canvasFileWriteThrough: false,
  upscaleCommandPath: null,
  rerunInterrupted: true,
};

function withDefaults<S extends z.ZodRawShape>(shape: S, defaults: { [K in keyof S]: z.output<S[K]> }) {
  const out: Record<string, z.ZodType> = {};
  for (const key in shape) {
    out[key] = (shape[key] as unknown as { default(v: unknown): z.ZodType }).default(defaults[key]);
  }
  return z.object(out as { [K in keyof S]: z.ZodDefault<S[K]> });
}

/** GET /api/settings. Parsing `{}` yields every default; unknown stored keys are dropped. */
export const settingsSchema = withDefaults(settingValues, SETTINGS_DEFAULTS);

/**
 * PATCH /api/settings. Only the keys being changed, no defaults filled in. The upscale program
 * can't be set over HTTP: anything that can reach the server could then choose what it runs.
 */
export const settingsPatchSchema = z.strictObject(settingValues).omit({ upscaleCommandPath: true }).partial();

export const SETTING_KEYS = Object.keys(settingValues) as SettingKey[];

/** GET /api/stats, for Settings > Storage. */
export const statsResponseSchema = z.object({
  assets: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  thumbsBytes: z.int().nonnegative(),
  dbBytes: z.int().nonnegative(),
  trash: z.object({ count: z.int().nonnegative(), bytes: z.int().nonnegative() }),
  /** Free space on the library's disk, when the server can tell. */
  freeBytes: z.int().nonnegative().nullable(),
  /** "originals" means sharp didn't load and thumbnails are the full images. */
  thumbnailEngine: z.enum(THUMB_ENGINES),
});

/** GET /api/health */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  /** Newest applied migration tag, e.g. "0001_assets_fts". */
  schema: z.string().nullable(),
  home: z.string(),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
