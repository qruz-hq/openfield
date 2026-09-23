import { canvasDocumentSchema } from "@openfield/core/canvas";
import { MODEL_BADGES } from "@openfield/core/constants";
import {
  batchHandleSchema,
  capabilitiesSchema,
  normalizedRequestSchema,
  presetObjectSchema,
  priceModelSchema,
  providerSettingValuesSchema,
  speedOfferSchema,
  usageUnitsSchema,
} from "@openfield/core/schemas";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import * as t from "./schema";

// Row schemas, one select/insert pair per table (§0.16). JSON columns that core describes are
// checked against core's schema; the others stay free-form JSON. Insert schemas guard writes
// whose data came from outside the process (bundles, imports, models.json).
// A function override keeps drizzle-zod's own nullable/optional handling for the column.

const badges = () => z.array(z.enum(MODEL_BADGES));
const capabilities = () => capabilitiesSchema;
const pricing = () => priceModelSchema;
const request = () => normalizedRequestSchema;
const speeds = () => z.array(speedOfferSchema);
const settings = () => providerSettingValuesSchema;
const handle = () => batchHandleSchema;
const graph = () => canvasDocumentSchema;

export const providerRow = createSelectSchema(t.providers, { settings });
export const newProviderRow = createInsertSchema(t.providers, { settings });
export const modelRow = createSelectSchema(t.models, { badges, capabilities, pricing, speeds });
export const newModelRow = createInsertSchema(t.models, { badges, capabilities, pricing, speeds });

export const jobSetRow = createSelectSchema(t.jobSets, { requestJson: request });
export const newJobSetRow = createInsertSchema(t.jobSets, { requestJson: request });
export const jobRow = createSelectSchema(t.jobs);
export const newJobRow = createInsertSchema(t.jobs);
export const providerBatchRow = createSelectSchema(t.providerBatches, { handle });
export const newProviderBatchRow = createInsertSchema(t.providerBatches, { handle });

export const assetRow = createSelectSchema(t.assets);
export const newAssetRow = createInsertSchema(t.assets);
export const assetEdgeRow = createSelectSchema(t.assetEdges);
export const newAssetEdgeRow = createInsertSchema(t.assetEdges);

export const folderRow = createSelectSchema(t.folders);
export const newFolderRow = createInsertSchema(t.folders);
export const assetFolderRow = createSelectSchema(t.assetFolders);
export const newAssetFolderRow = createInsertSchema(t.assetFolders);
export const favouriteRow = createSelectSchema(t.favourites);
export const newFavouriteRow = createInsertSchema(t.favourites);

export const presetRow = createSelectSchema(t.presets, { payloadJson: () => presetObjectSchema });
export const newPresetRow = createInsertSchema(t.presets, { payloadJson: () => presetObjectSchema });
export const presetAssetRow = createSelectSchema(t.presetAssets);
export const newPresetAssetRow = createInsertSchema(t.presetAssets);
export const referenceSetRow = createSelectSchema(t.referenceSets);
export const newReferenceSetRow = createInsertSchema(t.referenceSets);
export const referenceSetItemRow = createSelectSchema(t.referenceSetItems);
export const newReferenceSetItemRow = createInsertSchema(t.referenceSetItems);
export const characterRow = createSelectSchema(t.characters);
export const newCharacterRow = createInsertSchema(t.characters);
export const characterAssetRow = createSelectSchema(t.characterAssets);
export const newCharacterAssetRow = createInsertSchema(t.characterAssets);
export const paletteRow = createSelectSchema(t.palettes);
export const newPaletteRow = createInsertSchema(t.palettes);
export const savedPromptRow = createSelectSchema(t.savedPrompts);
export const newSavedPromptRow = createInsertSchema(t.savedPrompts);

export const canvasRow = createSelectSchema(t.canvases, { graph });
export const newCanvasRow = createInsertSchema(t.canvases, { graph });
export const canvasVersionRow = createSelectSchema(t.canvasVersions, { graph });
export const newCanvasVersionRow = createInsertSchema(t.canvasVersions, { graph });
export const canvasRunRow = createSelectSchema(t.canvasRuns);
export const newCanvasRunRow = createInsertSchema(t.canvasRuns);

export const usageLogRow = createSelectSchema(t.usageLog, { units: () => usageUnitsSchema });
export const newUsageLogRow = createInsertSchema(t.usageLog, { units: () => usageUnitsSchema });
export const settingRow = createSelectSchema(t.settings);
export const newSettingRow = createInsertSchema(t.settings);

export type ProviderRow = typeof t.providers.$inferSelect;
export type NewProviderRow = typeof t.providers.$inferInsert;
export type ModelRow = typeof t.models.$inferSelect;
export type NewModelRow = typeof t.models.$inferInsert;
export type JobSetRow = typeof t.jobSets.$inferSelect;
export type NewJobSetRow = typeof t.jobSets.$inferInsert;
export type JobRow = typeof t.jobs.$inferSelect;
export type NewJobRow = typeof t.jobs.$inferInsert;
export type ProviderBatchRow = typeof t.providerBatches.$inferSelect;
export type NewProviderBatchRow = typeof t.providerBatches.$inferInsert;
export type AssetRow = typeof t.assets.$inferSelect;
export type NewAssetRow = typeof t.assets.$inferInsert;
export type AssetEdgeRow = typeof t.assetEdges.$inferSelect;
export type NewAssetEdgeRow = typeof t.assetEdges.$inferInsert;
export type FolderRow = typeof t.folders.$inferSelect;
export type NewFolderRow = typeof t.folders.$inferInsert;
export type AssetFolderRow = typeof t.assetFolders.$inferSelect;
export type FavouriteRow = typeof t.favourites.$inferSelect;
export type PresetRow = typeof t.presets.$inferSelect;
export type NewPresetRow = typeof t.presets.$inferInsert;
export type PresetAssetRow = typeof t.presetAssets.$inferSelect;
export type ReferenceSetRow = typeof t.referenceSets.$inferSelect;
export type NewReferenceSetRow = typeof t.referenceSets.$inferInsert;
export type ReferenceSetItemRow = typeof t.referenceSetItems.$inferSelect;
export type CharacterRow = typeof t.characters.$inferSelect;
export type NewCharacterRow = typeof t.characters.$inferInsert;
export type CharacterAssetRow = typeof t.characterAssets.$inferSelect;
export type PaletteRow = typeof t.palettes.$inferSelect;
export type NewPaletteRow = typeof t.palettes.$inferInsert;
export type SavedPromptRow = typeof t.savedPrompts.$inferSelect;
export type NewSavedPromptRow = typeof t.savedPrompts.$inferInsert;
export type CanvasRow = typeof t.canvases.$inferSelect;
export type NewCanvasRow = typeof t.canvases.$inferInsert;
export type CanvasVersionRow = typeof t.canvasVersions.$inferSelect;
export type NewCanvasVersionRow = typeof t.canvasVersions.$inferInsert;
export type CanvasRunRow = typeof t.canvasRuns.$inferSelect;
export type NewCanvasRunRow = typeof t.canvasRuns.$inferInsert;
export type UsageLogRow = typeof t.usageLog.$inferSelect;
export type NewUsageLogRow = typeof t.usageLog.$inferInsert;
export type SettingRow = typeof t.settings.$inferSelect;
