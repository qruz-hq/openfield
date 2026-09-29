import { z } from "zod";
import {
  ADAPTER_OPS,
  ASPECT_RATIOS,
  BATCH_MAX,
  BATCH_STATES,
  ERROR_ACTIONS,
  ERROR_CODES,
  JOB_SET_STATES,
  JOB_SOURCES,
  JOB_STATES,
  MAX_PAGE_SIZE,
  MODALITIES,
  OPS,
  OUTPUT_FORMATS,
  REFERENCE_ROLES,
  RESOLUTION_TIERS,
  SPEED_IDS,
  VIDEO_RESOLUTIONS,
} from "../constants";
import { MODEL_ID_RE, PROVIDER_ID_RE } from "../ids";

export const ulidSchema = z.ulid();
/** Ids we don't mint ourselves, such as bundled preset ids ("of_preset_35mm_grain"). */
export const entityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const timestampSchema = z.iso.datetime({ offset: true });
/** A date or a full timestamp, as providers publish prices ("2026-09-23"). */
export const dateOrTimestampSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const providerIdSchema = z.string().regex(PROVIDER_ID_RE);
export const modelIdSchema = z.string().regex(MODEL_ID_RE);
export const modelKeySchema = z.templateLiteral([providerIdSchema, ":", modelIdSchema]);

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const usdSchema = z.number().nonnegative();

export const modalitySchema = z.enum(MODALITIES);
export const opSchema = z.enum(OPS);
export const jobStateSchema = z.enum(JOB_STATES);
export const jobSetStateSchema = z.enum(JOB_SET_STATES);
export const jobSourceSchema = z.enum(JOB_SOURCES);
export const errorCodeSchema = z.enum(ERROR_CODES);
export const errorActionSchema = z.enum(ERROR_ACTIONS);
export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export const resolutionTierSchema = z.enum(RESOLUTION_TIERS);
export const videoResolutionSchema = z.enum(VIDEO_RESOLUTIONS);
export const outputFormatSchema = z.enum(OUTPUT_FORMATS);
export const referenceRoleSchema = z.enum(REFERENCE_ROLES);
export const adapterOpSchema = z.enum(ADAPTER_OPS);
export const speedIdSchema = z.enum(SPEED_IDS);
export const batchStateSchema = z.enum(BATCH_STATES);

export const batchSchema = z.int().min(1).max(BATCH_MAX);
export const pixelSizeSchema = z.strictObject({
  width: z.int().min(1).max(16384),
  height: z.int().min(1).max(16384),
});

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

// Query strings arrive as text.
export const queryFlagSchema = z
  .enum(["0", "1", "true", "false"])
  .transform((v) => v === "1" || v === "true");
export const queryLimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE);
export const cursorSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const idParamSchema = z.object({ id: z.string().min(1).max(128) });

export type PixelSize = z.infer<typeof pixelSizeSchema>;
