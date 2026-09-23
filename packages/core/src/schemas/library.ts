import { z } from "zod";
import {
  CHARACTER_INJECTIONS,
  PALETTE_MODES,
  PRESET_SCHEMA_VERSION,
  PROMPT_SLOT,
  REFERENCE_SET_ROLES,
} from "../constants";
import { t } from "../i18n";
import { entityIdSchema, hexColorSchema, timestampSchema, ulidSchema } from "./common";

// Presets, reference sets, characters and palettes (§0.8, §5.3). The envelope below is the one
// JSON shape for export files, import and the presets.payload_json column.

const countSlots = (text: string) => text.split(PROMPT_SLOT).length - 1;

export const presetTemplateSchema = z
  .string()
  .max(4000)
  .refine((text) => countSlots(text) === 1, { error: () => t("presets.errors.slot", { slot: PROMPT_SLOT }) });

const referenceSetRoleSchema = z.enum(REFERENCE_SET_ROLES);

/** In the library a reference points at an asset. */
export const storedReferenceSchema = z.object({
  assetId: ulidSchema,
  weight: z.number().min(0).max(1).default(1),
  role: referenceSetRoleSchema,
});
/** In an export file it points at a file relative to the bundle root. */
export const bundledReferenceSchema = z.object({
  file: z
    .string()
    .min(1)
    .max(512)
    .refine((p) => !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes(".."), {
      error: () => t("presets.errors.outsideBundle"),
    }),
  weight: z.number().min(0).max(1).default(1),
  role: referenceSetRoleSchema,
});
const anyReferenceSchema = z.union([storedReferenceSchema, bundledReferenceSchema]);

export const paletteClauseSchema = z.object({
  hex: z.array(hexColorSchema).min(1).max(16),
  mode: z.enum(PALETTE_MODES),
});

const envelopeBase = {
  schemaVersion: z.literal(PRESET_SCHEMA_VERSION, {
    error: () => t("presets.errors.newerVersion"),
  }),
  id: entityIdSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  /** An asset id in the library, a file path in an export. */
  thumbnail: z.string().max(512).optional(),
  tags: z.array(z.string().max(40)).max(32).default([]),
  author: z.string().max(200).default(""),
  license: z.string().max(64).default(""),
  source: z.string().max(500).default(""),
  createdAt: timestampSchema.optional(),
  updatedAt: timestampSchema.optional(),
};

const styleFields = {
  kind: z.literal("style"),
  template: presetTemplateSchema,
  variants: z.object({ light: presetTemplateSchema.optional() }).optional(),
  negativePrompt: z.string().max(2000).optional(),
  strength: z.number().min(0).max(1).default(1),
  referenceStrength: z.number().min(0).max(1).optional(),
  /** Neutral settings, applied only where the model has them. */
  params: z.record(z.string(), z.unknown()).optional(),
  /** Keyed "<provider>:<modelId>" or "<provider>:*". */
  providerOverrides: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9_-]*:\S+$/), z.record(z.string(), z.unknown()))
    .optional(),
  palette: paletteClauseSchema.optional(),
};

/** A style preset as stored in presets.payload_json. */
export const presetObjectSchema = z.object({
  ...envelopeBase,
  ...styleFields,
  references: z.array(storedReferenceSchema).max(64).default([]),
});

const styleEnvelopeSchema = z.object({
  ...envelopeBase,
  ...styleFields,
  references: z.array(anyReferenceSchema).max(64).default([]),
});

const referenceSetEnvelopeSchema = z.object({
  ...envelopeBase,
  kind: z.literal("reference-set"),
  references: z.array(anyReferenceSchema).max(64),
});

const characterEnvelopeSchema = z.object({
  ...envelopeBase,
  kind: z.literal("character"),
  referenceSetId: entityIdSchema.nullable().optional(),
  /** Injected into the prompt. */
  descriptor: z.string().max(2000).default(""),
  lockSeed: z.boolean().default(false),
  seed: z.int().min(0).nullable().optional(),
  injection: z.enum(CHARACTER_INJECTIONS).default("prefix"),
  /** @-mention token, e.g. "@ana". */
  token: z
    .string()
    .regex(/^@[\w-]{1,40}$/)
    .nullable()
    .optional(),
  providerIdentity: z.record(z.string(), z.unknown()).nullable().optional(),
});

const paletteEnvelopeSchema = z.object({
  ...envelopeBase,
  kind: z.literal("palette"),
  hex: z.array(hexColorSchema).min(1).max(16),
  populations: z.array(z.number().min(0).max(1)).optional(),
  k: z.int().min(3).max(8).optional(),
  mode: z.enum(PALETTE_MODES).default("prompt"),
});

/** One exported object. Unknown keys are dropped on import. */
export const presetEnvelopeSchema = z.discriminatedUnion("kind", [
  styleEnvelopeSchema,
  referenceSetEnvelopeSchema,
  characterEnvelopeSchema,
  paletteEnvelopeSchema,
]);

/** `*.openfield-presets.json` */
export const presetBundleSchema = z.object({
  schemaVersion: z.literal(PRESET_SCHEMA_VERSION, { error: () => t("presets.errors.newerVersion") }),
  presets: z.array(presetEnvelopeSchema).min(1).max(1000),
});

/** POST /api/presets/import */
export const presetImportBodySchema = z.object({ items: z.array(presetEnvelopeSchema).min(1).max(1000) });
export const presetImportResponseSchema = z.object({
  imported: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  conflicts: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
});

// Library rows on the wire (§8.3)

export const presetSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  payload: presetObjectSchema,
  thumbUrl: z.string().nullable(),
  builtin: z.boolean(),
  origin: z.string().nullable(),
  sortOrder: z.int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const presetCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  payload: presetObjectSchema,
});
export const presetPatchBodySchema = presetCreateBodySchema.partial();

export const referenceSetItemSchema = z.object({
  assetId: ulidSchema,
  position: z.int().nonnegative(),
  weight: z.number().min(0).max(1),
  role: referenceSetRoleSchema,
});
export const referenceSetSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  items: z.array(referenceSetItemSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const referenceSetCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  items: z.array(referenceSetItemSchema).max(64),
});
export const referenceSetPatchBodySchema = referenceSetCreateBodySchema.partial();

export const characterSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  descriptor: z.string().nullable(),
  referenceSetId: entityIdSchema.nullable(),
  seed: z.int().nullable(),
  lockSeed: z.boolean(),
  injection: z.enum(CHARACTER_INJECTIONS).nullable(),
  token: z.string().nullable(),
  providerIdentity: z.record(z.string(), z.unknown()).nullable(),
  thumbUrl: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const characterCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  descriptor: z.string().max(2000),
  referenceSetId: entityIdSchema.optional(),
  seed: z.int().min(0).optional(),
  lockSeed: z.boolean().optional(),
  injection: z.enum(CHARACTER_INJECTIONS).optional(),
  token: z
    .string()
    .regex(/^@[\w-]{1,40}$/)
    .optional(),
});
export const characterPatchBodySchema = characterCreateBodySchema.partial();

export const paletteSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  hex: z.array(hexColorSchema),
  populations: z.array(z.number()),
  sourceAssetId: ulidSchema.nullable(),
  k: z.int(),
  mode: z.enum(PALETTE_MODES),
  builtin: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const paletteCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    hex: z.array(hexColorSchema).max(16).optional(),
    sourceAssetId: ulidSchema.optional(),
    k: z.int().min(3).max(8).optional(),
    mode: z.enum(PALETTE_MODES),
  })
  .refine((b) => (b.hex?.length ?? 0) > 0 || b.sourceAssetId !== undefined, {
    message: "Send hex colors or a source image",
  });
export const palettePatchBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  hex: z.array(hexColorSchema).min(1).max(16).optional(),
  mode: z.enum(PALETTE_MODES).optional(),
});

export const savedPromptSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
  presetId: entityIdSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const savedPromptCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  text: z.string().min(1).max(32_000),
  tags: z.array(z.string().max(40)).max(32).optional(),
  presetId: entityIdSchema.optional(),
});
export const savedPromptPatchBodySchema = savedPromptCreateBodySchema.partial();

export type PresetObject = z.infer<typeof presetObjectSchema>;
export type PresetEnvelope = z.infer<typeof presetEnvelopeSchema>;
export type PresetBundle = z.infer<typeof presetBundleSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type ReferenceSet = z.infer<typeof referenceSetSchema>;
export type Character = z.infer<typeof characterSchema>;
export type Palette = z.infer<typeof paletteSchema>;
export type SavedPrompt = z.infer<typeof savedPromptSchema>;
