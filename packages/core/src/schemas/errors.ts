import { z } from "zod";
import { ERROR_CODES, ERROR_HINT_ACTIONS, TRANSPORT_ERROR_CODES } from "../constants";
import { errorCodeSchema } from "./common";

// §0.5, §6.8. ErrorCode covers anything that reaches a job, a tile, a node or an SSE frame.
// Transport codes are HTTP-only and never overlap with it.

export const transportErrorCodeSchema = z.enum(TRANSPORT_ERROR_CODES);
export const apiErrorCodeSchema = z.enum([...TRANSPORT_ERROR_CODES, ...ERROR_CODES]);

/** Every non-2xx JSON response: `{ error: {...} }`. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    providerCode: z.string().optional(),
    retryable: z.boolean(),
    docsUrl: z.url().optional(),
    /** First failing field path for bad_request. */
    field: z.string().optional(),
    /** Our copy, when it says more than the code's usual words. Shown as is. */
    userMessage: z.string().optional(),
  }),
});

/** The data half of ProviderError; the class itself lives with the adapters. */
export const providerErrorDataSchema = z.object({
  code: errorCodeSchema,
  retryable: z.boolean(),
  /** Our copy, shown as is. */
  userMessage: z.string(),
  retryAfterMs: z.int().nonnegative().optional(),
  httpStatus: z.int().optional(),
  /** The provider's own code, for the error log only. */
  providerCode: z.string().optional(),
  field: z.string().optional(),
  hint: z.object({ action: z.enum(ERROR_HINT_ACTIONS), label: z.string() }).optional(),
});

/** What a failed job carries over the wire. `message` is detail for the error log, never the tile. */
export const jobErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  /** Our tile reason, when it says more than the code's usual words (§0.5). */
  reason: z.string().optional(),
  retryable: z.boolean(),
  retryAfterMs: z.int().nonnegative().optional(),
  httpStatus: z.int().optional(),
  providerCode: z.string().optional(),
  field: z.string().optional(),
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type ProviderErrorData = z.infer<typeof providerErrorDataSchema>;
export type JobError = z.infer<typeof jobErrorSchema>;
