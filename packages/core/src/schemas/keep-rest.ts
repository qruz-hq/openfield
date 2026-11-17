import { z } from "zod";
import { KEEP_REST_MODES, KEEP_REST_SENSITIVITY } from "../image/keep-rest";
import { MASK_COMPOSITE_MAX_PX } from "../image/mask";
import { assetSchema, KEEP_REST_FELL_BACK, lineUpSchema } from "./asset";
import { ulidSchema } from "./common";
import { markSchema } from "./marks";

// Keep the rest of the image, after the run (§0.9): an edit's stored model result can be laid over
// its original again with other settings, for free, and saved as an image of its own.

/**
 * Why a finished edit can't be adjusted:
 *   not_an_edit    it wasn't made with a mask or marks
 *   not_stored     it was made before the model's own result was kept
 *   original_gone  the image it edited was deleted for good
 *   area_gone      its mask was deleted for good
 *   in_trash       the edit itself is in the Trash
 *   saved_result   it's an edit's model result, saved as an image of its own
 */
export const KEEP_REST_UNAVAILABLE = [
  "not_an_edit",
  "not_stored",
  "original_gone",
  "area_gone",
  "in_trash",
  "saved_result",
] as const;

/** GET /api/assets/:id/keep-rest */
export const keepRestStateSchema = z.object({
  assetId: ulidSchema,
  available: z.boolean(),
  unavailable: z.enum(KEEP_REST_UNAVAILABLE).optional(),
  /** Plain words for why it's unavailable, or that the mask alone decided. */
  note: z.string().optional(),
  /** The library image is the kept version (on), or the model's own result (off). */
  keep: z.boolean(),
  mode: z.enum(KEEP_REST_MODES),
  sensitivity: z.int(),
  expandPx: z.int(),
  featherPx: z.int(),
  /** Where the area starts. With marks, it's marksArea(marks, base width, base height). */
  start: z.enum(["mask", "marks"]).nullable(),
  mask: z.object({ assetId: ulidSchema, url: z.string() }).nullable(),
  marks: z.array(markSchema).nullable(),
  /** The fix layer (fixesFromRgba reads it), when one was painted. */
  fixesUrl: z.string().nullable(),
  lineUp: lineUpSchema.nullable(),
  fellBack: z.enum(KEEP_REST_FELL_BACK).nullable(),
  changed: z.number().nullable(),
  revision: z.int(),
  /** The image that was edited, at full size. */
  base: z.object({ assetId: ulidSchema, url: z.string(), width: z.int(), height: z.int() }).nullable(),
  /**
   * The model's own result. `url` is the file as the model sent it; `fittedUrl` a PNG at the
   * original's size, the exact pixels the server lines up and blends (stretched to fit when the
   * model sent another size), for the browser's live preview. `savedAs` is the library image it
   * was saved as, while that's live.
   */
  modelResult: z
    .object({
      url: z.string(),
      fittedUrl: z.string(),
      width: z.int(),
      height: z.int(),
      mime: z.string(),
      bytes: z.int(),
      savedAs: ulidSchema.nullable(),
    })
    .nullable(),
  /**
   * The decided area at the original's size, white where the model is used and black where the
   * original is, grey along the feather, for the Difference view. Takes ?mode, ?sensitivity,
   * ?expandPx and ?featherPx to preview other settings without applying them.
   */
  areaUrl: z.string().nullable(),
});

/**
 * POST /api/assets/:id/keep-rest: lays the stored result over the original again, in place.
 * Anything left out stays as it is. `keep: false` is refused: the off state is only a view of the
 * stored result, which "Save as new image" adds to the library. A fix layer is sent as a PNG at the
 * original's size (multipart field "fixes", with these settings as JSON in "settings"); `fixes:
 * "clear"` drops the one stored.
 */
export const keepRestApplyBodySchema = z.object({
  keep: z.boolean().optional(),
  mode: z.enum(KEEP_REST_MODES).optional(),
  sensitivity: z.int().min(KEEP_REST_SENSITIVITY.min).max(KEEP_REST_SENSITIVITY.max).optional(),
  expandPx: z.int().min(0).max(MASK_COMPOSITE_MAX_PX).optional(),
  featherPx: z.int().min(0).max(MASK_COMPOSITE_MAX_PX).optional(),
  fixes: z.literal("clear").optional(),
});

/** ?mode, ?sensitivity, ?expandPx, ?featherPx on the area map. */
export const keepRestAreaQuerySchema = z.object({
  mode: z.enum(KEEP_REST_MODES).optional(),
  sensitivity: z.coerce
    .number()
    .int()
    .min(KEEP_REST_SENSITIVITY.min)
    .max(KEEP_REST_SENSITIVITY.max)
    .optional(),
  expandPx: z.coerce.number().int().min(0).max(MASK_COMPOSITE_MAX_PX).optional(),
  featherPx: z.coerce.number().int().min(0).max(MASK_COMPOSITE_MAX_PX).optional(),
});

export const keepRestApplyResponseSchema = z.object({
  asset: assetSchema,
  state: keepRestStateSchema,
  /** False when the settings decided the same image as before, so nothing was rewritten. */
  changed: z.boolean(),
});

/** POST /api/assets/:id/keep-rest/save */
export const keepRestSaveResponseSchema = z.object({
  asset: assetSchema,
  /** True when it had been saved already and that image came back. */
  existing: z.boolean(),
});

export type KeepRestUnavailable = (typeof KEEP_REST_UNAVAILABLE)[number];
export type KeepRestState = z.infer<typeof keepRestStateSchema>;
export type KeepRestApplyBody = z.infer<typeof keepRestApplyBodySchema>;
export type KeepRestAreaQuery = z.infer<typeof keepRestAreaQuerySchema>;
export type KeepRestApplyResponse = z.infer<typeof keepRestApplyResponseSchema>;
export type KeepRestSaveResponse = z.infer<typeof keepRestSaveResponseSchema>;
