import {
  CHARACTER_INJECTIONS,
  PALETTE_MODES,
  PRESET_ASSET_ROLES,
  REFERENCE_SET_ROLES,
} from "@openfield/core/constants";
import type { PresetObject } from "@openfield/core/schemas";
import { check, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { flag, json, oneOf } from "./_helpers";
import { assets } from "./assets";

// Four entities, four tables (§0.8). A preset is stored whole in payload_json, so an exported
// preset and a stored one are the same object. Style presets only: there is no kind column.
export const presets = sqliteTable("presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  payloadJson: json<PresetObject>("payload_json").notNull(),
  thumbAssetId: text("thumb_asset_id").references(() => assets.id, { onDelete: "set null" }),
  builtin: flag("builtin", 0), // bundled starters, copied on edit
  origin: text("origin"), // 'user' | 'import:<filename>'
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const presetAssets = sqliteTable(
  "preset_assets",
  {
    presetId: text("preset_id")
      .notNull()
      .references(() => presets.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    role: text("role", { enum: PRESET_ASSET_ROLES }).notNull(),
    weight: real("weight").notNull().default(1.0),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.presetId, t.assetId, t.role] }),
    check("preset_assets_role_check", oneOf("role", PRESET_ASSET_ROLES)),
  ],
);

export const referenceSets = sqliteTable("reference_sets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const referenceSetItems = sqliteTable(
  "reference_set_items",
  {
    setId: text("set_id")
      .notNull()
      .references(() => referenceSets.id, { onDelete: "cascade" }),
    // An asset id, never a hash or a path (§0.7).
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    weight: real("weight").notNull().default(1.0),
    role: text("role", { enum: REFERENCE_SET_ROLES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.assetId] }),
    check("reference_set_items_role_check", oneOf("role", REFERENCE_SET_ROLES)),
    index("idx_ref_set_items").on(t.setId, t.position),
  ],
);

// Our open stand-in for a trained identity: reference set + descriptor + optional pinned seed.
export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    descriptor: text("descriptor"), // prose injected into the prompt
    referenceSetId: text("reference_set_id").references(() => referenceSets.id),
    seed: integer("seed"),
    lockSeed: flag("lock_seed", 0),
    injection: text("injection", { enum: CHARACTER_INJECTIONS }),
    token: text("token"), // the @-mention token
    providerIdentityJson: json<Record<string, unknown>>("provider_identity_json"),
    thumbAssetId: text("thumb_asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  () => [check("characters_injection_check", oneOf("injection", CHARACTER_INJECTIONS))],
);

export const characterAssets = sqliteTable(
  "character_assets",
  {
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.characterId, t.assetId] })],
);

export const palettes = sqliteTable(
  "palettes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hexJson: json<string[]>("hex_json").notNull(),
    populationsJson: json<number[]>("populations_json").notNull(),
    sourceAssetId: text("source_asset_id").references(() => assets.id, { onDelete: "set null" }),
    k: integer("k").notNull(),
    mode: text("mode", { enum: PALETTE_MODES }).notNull(),
    builtin: flag("builtin", 0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  () => [check("palettes_mode_check", oneOf("mode", PALETTE_MODES))],
);

export const savedPrompts = sqliteTable("saved_prompts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  text: text("text").notNull(), // {{name}} variables resolve before preset templates
  tagsJson: json<string[]>("tags_json"),
  presetId: text("preset_id").references(() => presets.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
