import type { ModelManifest } from "@openfield/core";
import { type CallContext, redactError } from "../types";
import { API_BASE } from "./capabilities";
import { mapError } from "./errors";
import { openAiFetch } from "./http";
import { OPENAI_MODELS } from "./models";

// GET /v1/models lists ids with no capability field, so discovery only learns about dated
// snapshots of families we already know (§6.14). Every other id is listed as not supported.

// A family id, then an optional "-YYYY-MM-DD" snapshot date.
const FAMILY_RE = /^(gpt-image-2\.5-sunburst|gpt-image-2\.5-flare|gpt-image-2)(-\d{4}-\d{2}-\d{2})?$/;

export const recognise = (modelId: string): boolean => FAMILY_RE.test(modelId);

/** "gpt-image-2" for "gpt-image-2-2026-04-21". */
export function variantOf(modelId: string): string | undefined {
  const match = FAMILY_RE.exec(modelId);
  return match?.[2] ? match[1] : undefined;
}

/** The manifest for a cataloged or recognised id. Static capabilities always win. */
export function manifestFor(modelId: string): ModelManifest | undefined {
  const cataloged = OPENAI_MODELS.find((m) => m.modelId === modelId);
  if (cataloged) return structuredClone(cataloged);
  const match = FAMILY_RE.exec(modelId);
  const base = match && OPENAI_MODELS.find((m) => m.modelId === match[1]);
  if (!match?.[2] || !base) return undefined;
  return {
    ...structuredClone(base),
    key: `openai:${modelId}`,
    modelId,
    displayName: `${base.displayName} (${match[2].slice(1)})`,
    source: "discovered",
  };
}

/** Every model id the key can see. Free: listing models isn't billed. */
export async function discoverIds(ctx: CallContext): Promise<string[]> {
  const { res, body } = await openAiFetch(ctx, `${API_BASE}/models`);
  if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
  const list = body as { data?: { id?: unknown }[] } | undefined;
  return (list?.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
}

/**
 * The catalog plus recognised discoveries, cataloged ids first. A snapshot of a model the key also
 * lists is left out: it's the same model under a second name.
 */
export function mergeDiscovered(ids: string[]): ModelManifest[] {
  const models = OPENAI_MODELS.map((m) => structuredClone(m));
  const known = new Set(models.map((m) => m.modelId));
  const listed = new Set(ids);
  for (const id of ids) {
    if (known.has(id) || !recognise(id)) continue;
    const base = variantOf(id);
    if (base && listed.has(base)) continue;
    const manifest = manifestFor(id);
    if (manifest) {
      models.push(manifest);
      known.add(id);
    }
  }
  return models;
}
