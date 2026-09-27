import {
  BATCH_MAX,
  CANVAS_SEED_MODES,
  type ModelKey,
  modelKeySchema,
  type ResolutionTier,
  resolutionTierSchema,
  type SizeSpec,
  sizeSpecSchema,
  ulidSchema,
} from "@openfield/core";

// Lenient readers for saved params: a value that doesn't fit is dropped for the default, never
// thrown on, so an old or hand-edited canvas still opens (parseParams' contract).

type Raw = Readonly<Record<string, unknown>>;

export const readString = (raw: Raw, key: string, fallback = ""): string =>
  typeof raw[key] === "string" ? (raw[key] as string) : fallback;

export const readBoolean = (raw: Raw, key: string, fallback = false): boolean =>
  typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;

export function readInt(raw: Raw, key: string, min: number, max: number, fallback: number): number {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export const readModel = (value: unknown): ModelKey | undefined => {
  const parsed = modelKeySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const readModels = (value: unknown): ModelKey[] =>
  Array.isArray(value) ? value.flatMap((v) => (readModel(v) ? [readModel(v)!] : [])) : [];

export const readAssetIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => ulidSchema.safeParse(v).success) : [];

export const readSize = (value: unknown): SizeSpec | undefined => {
  const parsed = sizeSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const readResolution = (value: unknown): ResolutionTier | undefined => {
  const parsed = resolutionTierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const readQuality = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;

export const readBatch = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? Math.min(BATCH_MAX, value) : fallback;

export type SeedMode = (typeof CANVAS_SEED_MODES)[number];
export interface SeedParam {
  mode: SeedMode;
  value?: number;
}

export function readSeed(value: unknown): SeedParam {
  if (typeof value !== "object" || value === null) return { mode: "random" };
  const v = value as { mode?: unknown; value?: unknown };
  const mode = (CANVAS_SEED_MODES as readonly unknown[]).includes(v.mode) ? (v.mode as SeedMode) : "random";
  return typeof v.value === "number" && Number.isInteger(v.value) && v.value >= 0
    ? { mode, value: v.value }
    : { mode };
}

export const readRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as object) } : {};
