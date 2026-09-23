import {
  AUTH_KINDS,
  CREDENTIAL_SOURCES,
  ERROR_CODES,
  MODALITIES,
  MODEL_SOURCES,
  type ModelBadge,
} from "@openfield/core/constants";
import type { Capabilities, PriceModel } from "@openfield/core/schemas";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { flag, json, oneOf } from "./_helpers";

// No secret ever lands here. credential_ref points into config.json or the environment.
export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey(), // 'openai', 'google', … never contains a colon (§0.2)
    displayName: text("display_name").notNull(),
    adapter: text("adapter").notNull(),
    authKind: text("auth_kind", { enum: AUTH_KINDS }).notNull(),
    credentialRef: text("credential_ref"), // e.g. 'keys.openai': a path, never a value
    credentialSource: text("credential_source", { enum: CREDENTIAL_SOURCES }).notNull().default("unset"),
    credentialHint: text("credential_hint"), // last 4 characters only
    baseUrl: text("base_url"),
    enabled: flag("enabled", 1),
    concurrencyCap: integer("concurrency_cap").notNull().default(2),
    lastOkAt: text("last_ok_at"),
    // The ErrorCode of the last failed key check. The provider's own message goes to the error log (§0.5).
    lastError: text("last_error", { enum: ERROR_CODES }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  () => [
    check("providers_auth_kind_check", oneOf("auth_kind", AUTH_KINDS)),
    check("providers_credential_source_check", oneOf("credential_source", CREDENTIAL_SOURCES)),
  ],
);

// Cache of the model registry (§6.4): the adapter's static catalog plus allow-listed discoveries.
export const models = sqliteTable(
  "models",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(), // provider-native id
    displayName: text("display_name").notNull(),
    family: text("family"),
    modality: text("modality", { enum: MODALITIES }).notNull().default("image"),
    badges: json<ModelBadge[]>("badges"),
    capabilities: json<Capabilities>("capabilities").notNull(),
    pricing: json<PriceModel>("pricing"),
    source: text("source", { enum: MODEL_SOURCES }).notNull(),
    enabled: flag("enabled", 1),
    sortOrder: integer("sort_order").notNull().default(0),
    discoveredAt: text("discovered_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.modelId] }),
    check("models_modality_check", oneOf("modality", MODALITIES)),
    check("models_source_check", oneOf("source", MODEL_SOURCES)),
  ],
);
