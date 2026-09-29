import { z } from "zod";
import { CREDENTIAL_SOURCES, MAX_CONCURRENCY } from "../constants";
import {
  dateOrTimestampSchema,
  errorCodeSchema,
  modelIdSchema,
  modelKeySchema,
  providerIdSchema,
  timestampSchema,
} from "./common";
import { priceModelSchema } from "./cost";
import { providerErrorDataSchema } from "./errors";
import { modelManifestSchema } from "./manifest";

// Provider data (§6.2). Behaviour (Provider, CallContext, ImageModel) lives in packages/providers.

/** A host, or "*.parent.example" for any one label under a parent the company owns. */
const hostSchema = z
  .string()
  .regex(/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i)
  .max(253);

export const providerMetaSchema = z.strictObject({
  id: providerIdSchema,
  /** Our label, e.g. "OpenAI". */
  displayName: z.string().min(1),
  docsUrl: z.url(),
  /** Where the person creates a key. */
  consoleUrl: z.url(),
  /** Every API host this adapter may contact. */
  networkHosts: z.array(hostSchema),
  /**
   * Every host an image may be downloaded from. Empty means bytes arrive inline. "*.parent" allows
   * exactly one label under a parent the company owns, for storage that names a bucket per region.
   */
  assetHosts: z.array(hostSchema),
  /** false keeps it behind Settings > Experimental. */
  stable: z.boolean(),
});

/**
 * Whether `host` is one the patterns name: exactly, or for "*.parent.example" as a single label
 * under it (never the parent itself, and never two labels deep). Case doesn't matter.
 */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (!pattern.startsWith("*.")) return h === pattern;
    const parent = pattern.slice(1);
    if (!h.endsWith(parent)) return false;
    const label = h.slice(0, -parent.length);
    return /^[a-z0-9-]+$/.test(label);
  });
}

export const credentialFieldSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  label: z.string().min(1),
  /** Write-only over HTTP and masked in the UI. */
  secret: z.boolean(),
  required: z.boolean(),
  placeholder: z.string().optional(),
  /** A hint for the form, never a reason to reject a key. */
  pattern: z.string().optional(),
  /** e.g. ["OPENFIELD_OPENAI_API_KEY", "OPENAI_API_KEY"], first wins. */
  envVars: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  help: z.string().optional(),
});

export const credentialSchemaSchema = z.strictObject({
  fields: z.array(credentialFieldSchema).min(1),
  /** Non-secret settings stored beside the key, such as a custom server address. */
  options: z.array(credentialFieldSchema).optional(),
});

export const credentialValuesSchema = z.record(z.string(), z.string());

export const priceTableSchema = z.object({
  models: z.record(modelKeySchema, priceModelSchema),
  fetchedAt: dateOrTimestampSchema,
  sourceUrl: z.url(),
});

export const refreshReportSchema = z.object({
  providerId: providerIdSchema,
  added: z.array(modelKeySchema),
  updated: z.array(modelKeySchema),
  removed: z.array(modelKeySchema),
  /** Discovered ids the adapter doesn't recognise. Listed, never added to the picker. */
  unrecognised: z.array(z.object({ modelId: modelIdSchema, seenAt: timestampSchema })),
  error: providerErrorDataSchema.optional(),
  checkedAt: timestampSchema,
});

// HTTP: providers, keys and models (§8.3)

/** GET /api/providers items. */
export const providerSummarySchema = z.object({
  id: providerIdSchema,
  displayName: z.string(),
  enabled: z.boolean(),
  credentialSource: z.enum(CREDENTIAL_SOURCES),
  /** Last four characters only. */
  credentialHint: z.string().max(8).nullable(),
  lastOkAt: timestampSchema.nullable(),
  lastError: z.string().nullable(),
  lastErrorCode: errorCodeSchema.nullable(),
  concurrencyCap: z.int().min(1),
  meta: providerMetaSchema,
  credentials: credentialSchemaSchema,
});
export const providersListResponseSchema = z.array(providerSummarySchema);

/**
 * PATCH /api/providers/:id. No custom server address in v1: that waits for the OpenAI-compatible
 * provider in v1.1 (§6.18).
 */
export const providerPatchBodySchema = z.strictObject({
  enabled: z.boolean().optional(),
  concurrencyCap: z.int().min(1).max(MAX_CONCURRENCY).optional(),
});

/** GET /api/settings/keys items. Status only: no endpoint ever returns a key. */
export const keyStatusSchema = z.object({
  providerId: providerIdSchema,
  present: z.boolean(),
  source: z.enum(CREDENTIAL_SOURCES),
  hint: z.string().max(8).nullable(),
  /** The environment variable in effect, when the key is set outside Openfield. */
  envVar: z.string().nullable(),
  lastOkAt: timestampSchema.nullable(),
  lastErrorCode: errorCodeSchema.nullable(),
});
export const keysStatusResponseSchema = z.array(keyStatusSchema);

const keyValuesSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  z.string().trim().min(1).max(4096),
);

/** PUT /api/settings/keys/:providerId, e.g. { apiKey } or { keyId, keySecret }. */
export const keyPutBodySchema = keyValuesSchema.refine((values) => Object.keys(values).length > 0, {
  message: "Send at least one field",
});

/**
 * POST /api/settings/keys/:providerId/test. No body checks the saved key. With values, the server
 * checks those instead and saves them only if they work (§2.10 step 5).
 */
export const keyTestBodySchema = keyValuesSchema;

/** POST /api/settings/keys/:providerId/test */
export const keyTestResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.int().nonnegative(),
  /** How many models this key can use, shown on success. */
  modelCount: z.int().nonnegative().optional(),
  error: z.object({ code: errorCodeSchema, message: z.string() }).optional(),
});

export const providerParamSchema = z.object({ providerId: providerIdSchema });
export const modelParamSchema = z.object({ providerId: providerIdSchema, modelId: modelIdSchema });

/**
 * GET /api/models query. `modality` defaults to image, so image pickers never offer a video model;
 * "all" lists every model.
 */
export const modelsListQuerySchema = z.object({
  provider: providerIdSchema.optional(),
  modality: z.enum(["image", "video", "audio", "all"]).optional(),
  refresh: z.enum(["0", "1"]).optional(),
});

/** A manifest plus what the picker needs to group it. */
export const modelListItemSchema = modelManifestSchema.safeExtend({
  /** The model's company has a usable key. */
  ready: z.boolean(),
  enabled: z.boolean(),
});
export const modelsListResponseSchema = z.object({
  models: z.array(modelListItemSchema),
  /** When the list is due for a refresh. */
  staleAt: timestampSchema.nullable(),
});

/** POST /api/models/refresh */
export const modelsRefreshBodySchema = z.object({ providerId: providerIdSchema.optional() });
export const modelsRefreshResponseSchema = z.object({
  added: z.array(modelKeySchema),
  updated: z.array(modelKeySchema),
  removed: z.array(modelKeySchema),
  errors: z.array(z.object({ providerId: providerIdSchema, code: errorCodeSchema, message: z.string() })),
});

export type ProviderMeta = z.infer<typeof providerMetaSchema>;
export type CredentialField = z.infer<typeof credentialFieldSchema>;
export type CredentialSchema = z.infer<typeof credentialSchemaSchema>;
export type CredentialValues = z.infer<typeof credentialValuesSchema>;
export type PriceTable = z.infer<typeof priceTableSchema>;
export type RefreshReport = z.infer<typeof refreshReportSchema>;
export type ProviderSummary = z.infer<typeof providerSummarySchema>;
export type ProviderPatchBody = z.infer<typeof providerPatchBodySchema>;
export type KeyStatus = z.infer<typeof keyStatusSchema>;
export type KeyPutBody = z.infer<typeof keyPutBodySchema>;
export type KeyTestBody = z.infer<typeof keyTestBodySchema>;
export type KeyTestResponse = z.infer<typeof keyTestResponseSchema>;
export type ModelListItem = z.infer<typeof modelListItemSchema>;
export type ModelsListResponse = z.infer<typeof modelsListResponseSchema>;
export type ModelsRefreshResponse = z.infer<typeof modelsRefreshResponseSchema>;

/**
 * Whether a company is early (meta.stable false, §6.2): it shows only with Settings > Experimental
 * on, and its models are never picked for the person.
 */
export function isEarly(
  providers: readonly Pick<ProviderSummary, "id" | "meta">[] | undefined,
  providerId: string,
): boolean {
  return providers?.find((p) => p.id === providerId)?.meta.stable === false;
}
