import type { ModelManifest } from "@openfield/core";
import { type CallContext, redactError } from "../types";
import { API_BASE } from "./capabilities";
import { mapError } from "./errors";
import { googleFetch } from "./http";
import { GOOGLE_MODELS } from "./models";

// models.list doesn't say which models make images (no output-modality field), so discovery only
// learns about new versions of families we already know (§6.13). Every other id is listed as
// not supported and never reaches the picker.

// A family id, then an optional "-preview" and an optional "-MM-YYYY" snapshot date.
const FAMILY_RE =
  /^(gemini-3-pro-image|gemini-3\.1-flash-image|gemini-3\.1-flash-lite-image)(-preview)?(-\d{2}-\d{4})?$/;

export const recognise = (modelId: string): boolean => FAMILY_RE.test(modelId);

/** "gemini-3-pro-image" for "gemini-3-pro-image-preview" or a dated snapshot of it. */
export function variantOf(modelId: string): string | undefined {
  const match = FAMILY_RE.exec(modelId);
  return match && (match[2] || match[3]) ? match[1] : undefined;
}

/** The manifest for a cataloged or recognised id. Static capabilities always win. */
export function manifestFor(modelId: string): ModelManifest | undefined {
  const cataloged = GOOGLE_MODELS.find((m) => m.modelId === modelId);
  if (cataloged) return structuredClone(cataloged);

  const match = FAMILY_RE.exec(modelId);
  const base = match && GOOGLE_MODELS.find((m) => m.modelId === match[1]);
  if (!match || !base) return undefined;
  const suffix = modelId.slice(match[1]!.length + 1).replace(/-/g, " ");
  return {
    ...structuredClone(base),
    key: `google:${modelId}`,
    modelId,
    displayName: `${base.displayName} (${suffix})`,
    ...(match[2] && { badges: ["preview" as const] }),
    source: "discovered",
  };
}

const MAX_PAGES = 5;

/** Every model id the key can see. Free: models.list isn't billed. */
export async function discoverIds(ctx: CallContext): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API_BASE}/models`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const { res, body } = await googleFetch(ctx, url);
    if (!res.ok) throw redactError(await mapError(res, body), ctx.log);

    const list = body as { models?: { name?: string }[]; nextPageToken?: string } | undefined;
    for (const model of list?.models ?? []) {
      if (typeof model.name === "string") ids.push(model.name.replace(/^models\//, ""));
    }
    pageToken = list?.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

/**
 * The catalog plus recognised discoveries, cataloged ids first. A preview or snapshot of a model
 * the key also lists is left out: it's the same model under a second name.
 */
export function mergeDiscovered(ids: string[]): ModelManifest[] {
  const models = GOOGLE_MODELS.map((m) => structuredClone(m));
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
