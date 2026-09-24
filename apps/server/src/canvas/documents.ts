import { canonicalJson, type ModelKey, t } from "@openfield/core";
import {
  CANVAS_SCHEMA,
  type CanvasDocument,
  CanvasVersionError,
  migrateCanvasDocument,
} from "@openfield/core/canvas";
import { type Executor, getAssets } from "@openfield/db";
import { ApiFailure } from "../http/errors";
import type { ModelService } from "../services/models";
import type { SettingsService } from "../services/settings";

// Small rules every canvas route shares: what a saved document must say about itself, what the
// index keeps beside it, and which model a new node starts on.

/** Node types whose params.model a new canvas fills in when it's missing. */
const MODEL_NODE_TYPES = new Set(["image.generate", "image.variations"]);
/** How many result images to look through for a card's cover. */
const COVER_CANDIDATES = 200;

export function emptyDocument(id: string, name: string, at: string): CanvasDocument {
  return {
    schema: CANVAS_SCHEMA,
    id,
    name,
    createdAt: at,
    updatedAt: at,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    comments: [],
    meta: {},
  };
}

/** A stored or imported document in the current shape. A newer one is refused with our copy (R14). */
export function readDocument(raw: unknown): CanvasDocument {
  try {
    return migrateCanvasDocument(raw);
  } catch (err) {
    if (err instanceof CanvasVersionError && err.version !== null) {
      throw new ApiFailure(409, "conflict", err.message, { userMessage: t("canvas.errors.newerVersion") });
    }
    throw err;
  }
}

/** The server's word on identity: the row's id and name win over whatever the body says. */
export function stamp(
  doc: CanvasDocument,
  fields: { id: string; name: string; updatedAt: string; createdAt?: string },
): CanvasDocument {
  return {
    ...doc,
    id: fields.id,
    name: fields.name,
    updatedAt: fields.updatedAt,
    ...(fields.createdAt && { createdAt: fields.createdAt }),
  };
}

/** Same content apart from the save time and where the view sits, so panning makes no snapshot. */
export function sameContent(a: CanvasDocument, b: CanvasDocument): boolean {
  const strip = ({ updatedAt: _u, viewport: _v, ...rest }: CanvasDocument) => rest;
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

/** Result images, newest run first, for the card's cover. */
function coverCandidates(doc: CanvasDocument): string[] {
  const results = doc.nodes
    .map((n) => n.result)
    .filter((r) => r !== null && r.assetIds.length > 0)
    .sort((a, b) => (b!.ranAt ?? "").localeCompare(a!.ranAt ?? ""));
  return results.flatMap((r) => r!.assetIds).slice(0, COVER_CANDIDATES);
}

/** The newest result image still in the library, or null. */
export function pickCover(db: Executor, doc: CanvasDocument): string | null {
  const candidates = coverCandidates(doc);
  if (candidates.length === 0) return null;
  const live = new Set(getAssets(db, candidates).map((a) => a.id));
  return candidates.find((id) => live.has(id)) ?? null;
}

/** Every image a document names: the nodes' own images and what their runs made. No repeats. */
export function documentAssetIds(doc: CanvasDocument): string[] {
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    const own = node.params.assetIds;
    if (Array.isArray(own)) for (const id of own) if (typeof id === "string") ids.add(id);
    for (const id of node.result?.assetIds ?? []) ids.add(id);
  }
  return [...ids];
}

export function documentCounts(doc: CanvasDocument): { nodeCount: number; edgeCount: number } {
  return { nodeCount: doc.nodes.length, edgeCount: doc.edges.length };
}

/** The Defaults setting, else the first model that can run right now, else none. */
export function defaultModel(models: ModelService, settings: SettingsService): ModelKey | null {
  const chosen = settings.get().defaultModel;
  if (chosen && models.get(chosen)) return chosen;
  const ready = models.list().models.find((m) => m.ready && m.enabled);
  return ready?.key ?? null;
}

/** Gives Generate and Variations nodes without a model the default one, so a new canvas can run. */
export function fillModels(doc: CanvasDocument, model: ModelKey | null): CanvasDocument {
  if (!model) return doc;
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (!MODEL_NODE_TYPES.has(node.type) || typeof node.params.model === "string") return node;
    changed = true;
    return { ...node, params: { ...node.params, model } };
  });
  return changed ? { ...doc, nodes } : doc;
}
