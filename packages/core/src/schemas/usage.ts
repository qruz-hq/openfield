import { z } from "zod";
import { isTimeZone } from "../calendar";
import {
  MAINTENANCE_TASKS,
  USAGE_GROUP_BY,
  USAGE_PLACES,
  USAGE_SERIES_GROUPS,
  USAGE_STEPS,
} from "../constants";
import { currencySchema, modelIdSchema, providerIdSchema, timestampSchema, usdSchema } from "./common";

/** GET /api/usage */
export const usageQuerySchema = z.object({
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  groupBy: z.enum(USAGE_GROUP_BY).default("day"),
});

export const usageRowSchema = z.object({
  /** "YYYY-MM-DD" when grouped by day. */
  day: z.string().optional(),
  providerId: providerIdSchema.optional(),
  modelId: modelIdSchema.optional(),
  runs: z.int().nonnegative(),
  images: z.int().nonnegative(),
  usd: usdSchema,
  /** Canceled after submit: may be billed, no image to show for it. */
  usdDiscarded: usdSchema,
  /**
   * Images that ran again after a restart, whatever came of it, so the company may have billed the
   * call each one replaced too (§0.13). A count, because a row sums many runs.
   */
  reruns: z.int().nonnegative().optional(),
});

export const usageResponseSchema = z.object({
  rows: z.array(usageRowSchema),
  totalUsd: usdSchema,
  discardedUsd: usdSchema,
  currency: currencySchema,
});

/** GET /api/usage/series: Settings > Spending's chart, tiles and table (§6.9). */
export const usageSeriesQuerySchema = z.object({
  /** Included. Absent: from the first thing ever tracked. */
  from: timestampSchema.optional(),
  /** Excluded. Absent: up to now. */
  to: timestampSchema.optional(),
  /** The viewer's IANA zone. Days, weeks and months are on their wall clock. */
  tz: z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone"),
  step: z.enum(USAGE_STEPS).default("day"),
  groupBy: z.enum(USAGE_SERIES_GROUPS).default("model"),
});

/** What one slice of the log adds up to. Same rules as the rollup: failures never cost anything. */
export const usageFiguresSchema = z.object({
  /** Succeeded and canceled-after-submit runs. */
  runs: z.int().nonnegative(),
  images: z.int().nonnegative(),
  /** Spent on images you have. */
  usd: usdSchema,
  /** Canceled after submit: may be billed, no image to show for it. */
  usdDiscarded: usdSchema,
  /** How many runs were canceled after submit. */
  canceled: z.int().nonnegative(),
  /** Images that ran again after a restart, so the call each replaced may be billed too. */
  reruns: z.int().nonnegative(),
});

export const usageSeriesGroupSchema = usageFiguresSchema.extend({
  /** Stable across ranges: "google:gemini-3-pro-image", "google", "2K|high", "canvas". */
  key: z.string(),
  providerId: providerIdSchema.optional(),
  modelId: modelIdSchema.optional(),
  /** Size and quality groups. Null when the run didn't ask for one. */
  resolution: z.string().nullable().optional(),
  quality: z.string().nullable().optional(),
  place: z.enum(USAGE_PLACES).optional(),
  /** Place "agent": the app that asked, such as "Claude Code". */
  agent: z.string().optional(),
});

export const usageSeriesBucketSchema = z.object({
  /** "YYYY-MM-DD": the day, the week's Monday or the month's 1st. "YYYY-MM-DDTHH" for hours. */
  start: z.string(),
  /** Only the groups with something in this bucket. */
  groups: z.record(z.string(), z.object({ usd: usdSchema, images: z.int().nonnegative() })),
});

export const usageSeriesResponseSchema = z.object({
  step: z.enum(USAGE_STEPS),
  groupBy: z.enum(USAGE_SERIES_GROUPS),
  /** Every bucket in the range, empty ones included, oldest first. */
  buckets: z.array(usageSeriesBucketSchema),
  /** Most spent first. */
  groups: z.array(usageSeriesGroupSchema),
  totals: usageFiguresSchema,
  /** Different models used in the range, whatever the grouping. */
  models: z.int().nonnegative(),
  /** The first day anything was tracked, in `tz`. Null when nothing ever was. */
  firstDay: z.string().nullable(),
  currency: currencySchema,
});

/** POST /api/maintenance/gc. Dry run unless told otherwise. */
export const gcBodySchema = z.object({ dryRun: z.boolean().default(true) });
export const gcResponseSchema = z.object({
  orphanFiles: z.int().nonnegative(),
  missingRows: z.int().nonnegative(),
  staleThumbs: z.int().nonnegative(),
  reclaimedBytes: z.int().nonnegative(),
});

/** POST /api/maintenance/backup */
export const backupBodySchema = z.object({ includeAssets: z.boolean().optional() });
export const backupResponseSchema = z.object({ path: z.string(), bytes: z.int().nonnegative() });

/** POST /api/maintenance/reindex */
export const reindexBodySchema = z.object({ fts: z.boolean().optional(), thumbs: z.boolean().optional() });
export const reindexResponseSchema = z.object({ jobId: z.string() });

export const maintenanceTaskSchema = z.enum(MAINTENANCE_TASKS);

export type UsageRow = z.infer<typeof usageRowSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
export type UsageSeriesQuery = z.infer<typeof usageSeriesQuerySchema>;
export type UsageFigures = z.infer<typeof usageFiguresSchema>;
export type UsageSeriesGroup = z.infer<typeof usageSeriesGroupSchema>;
export type UsageSeriesBucket = z.infer<typeof usageSeriesBucketSchema>;
export type UsageSeriesResponse = z.infer<typeof usageSeriesResponseSchema>;
