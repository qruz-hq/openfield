import { z } from "zod";
import { MAINTENANCE_TASKS, USAGE_GROUP_BY } from "../constants";
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
});

export const usageResponseSchema = z.object({
  rows: z.array(usageRowSchema),
  totalUsd: usdSchema,
  discardedUsd: usdSchema,
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
