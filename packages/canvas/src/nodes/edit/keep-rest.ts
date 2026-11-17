import { KEEP_REST_SENSITIVITY, type KeepRestMode } from "@openfield/core";
import type { CanvasNodeResult } from "@openfield/core/canvas";
import { type FingerprintCache, planFingerprints, resolveFingerprints } from "../../engine/fingerprint";
import type { EngineContext } from "../../engine/types";
import { isLocked } from "../../store/graph";
import { applyOps, type CanvasOp, type DocSlice } from "../../store/ops";
import type { NodeRegistry } from "../registry";
import { editSpec } from "./spec";

// Keep the rest after an Edit node ran (§0.9): its model's own result is kept with each image, so
// changing only how the rest is kept blends the images again on the server, for free and in place.
// The node then stays up to date: its result is marked as made with the new settings. Nodes after
// it read an image that changed, and their fingerprints carry this node's, so they go out of date.
// The web inspector and the agents' tools both settle a re-blend with these ops.

/** The Edit node settings that only decide how the rest is kept. */
export const KEEP_REST_PARAMS = [
  "keepOriginal",
  "sketchKeepOriginal",
  "sensitivity",
  "expandPx",
  "featherPx",
  "keepRestMode",
] as const;

export type KeepRestParam = (typeof KEEP_REST_PARAMS)[number];

const KEEP_REST_KEYS: ReadonlySet<string> = new Set(KEEP_REST_PARAMS);

/** How an Edit node keeps the rest, from its raw params, read as parseParams does. */
export interface EditKeepRest {
  /** Sketch & point: the area starts from the marks, and the switch is sketchKeepOriginal. */
  sketch: boolean;
  keep: boolean;
  mode: KeepRestMode;
  sensitivity: number;
  expandPx: number;
  featherPx: number;
}

export function editKeepRestOf(raw: Readonly<Record<string, unknown>>, ctx: EngineContext): EditKeepRest {
  const p = editSpec.parseParams(raw, ctx);
  const sketch = p.mode === "sketch";
  return {
    sketch,
    keep: sketch ? !!p.sketchKeepOriginal : p.keepOriginal,
    mode: p.keepRestMode ?? "smart",
    sensitivity: p.sensitivity ?? KEEP_REST_SENSITIVITY.default,
    expandPx: p.expandPx,
    featherPx: p.featherPx,
  };
}

export const sameKeepRest = (a: EditKeepRest, b: EditKeepRest): boolean =>
  a.sketch === b.sketch &&
  a.keep === b.keep &&
  a.mode === b.mode &&
  a.sensitivity === b.sensitivity &&
  a.expandPx === b.expandPx &&
  a.featherPx === b.featherPx;

/** A params patch that touches nothing but how the rest is kept. */
export const onlyKeepRest = (patch: Readonly<Record<string, unknown>>): boolean => {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => KEEP_REST_KEYS.has(key));
};

/**
 * What POST /api/assets/:id/keep-rest takes to make an image match these settings. Always "on":
 * the server never turns Keep the rest off in place.
 */
export const keepRestBody = (k: EditKeepRest) => ({
  keep: true as const,
  mode: k.mode,
  sensitivity: k.sensitivity,
  expandPx: k.expandPx,
  featherPx: k.featherPx,
});

/**
 * An Edit node whose images can be blended again for free: not locked, with images made from its
 * current settings and from what it reads now. `fingerprint` is the node's current one and
 * `inputsChanged` the live analysis's, so a node that's out of date anyway waits for its Run.
 */
export function canReblend(
  doc: DocSlice,
  id: string,
  fingerprint: string | undefined,
  inputsChanged: boolean,
): boolean {
  const frame = doc.nodes[id];
  const result = doc.results[id];
  return (
    frame?.type === editSpec.type &&
    !isLocked(doc, id) &&
    !!result &&
    (result.state === "done" || result.state === "cached") &&
    result.assetIds.length > 0 &&
    !!fingerprint &&
    result.fingerprint === fingerprint &&
    !inputsChanged
  );
}

/** The node's fingerprint once a params patch lands. */
export async function fingerprintAfter(
  doc: DocSlice,
  registry: NodeRegistry,
  ctx: EngineContext,
  id: string,
  patch: Readonly<Record<string, unknown>>,
  cache: FingerprintCache = new Map(),
): Promise<string> {
  const next = applyOps(doc, [{ op: "setParams", id, patch }]).doc;
  const all = await resolveFingerprints(planFingerprints(next, registry, ctx), cache);
  const fingerprint = all[id];
  if (!fingerprint) throw new Error(`No fingerprint for ${id}`);
  return fingerprint;
}

/**
 * The ops that settle a re-blend: the new settings, and the result marked as made with them. With
 * `assetIds` (the switch turned off or on again), the node's images are those instead.
 */
export async function reblendOps(
  doc: DocSlice,
  registry: NodeRegistry,
  ctx: EngineContext,
  id: string,
  patch: Readonly<Record<string, unknown>>,
  opts: { assetIds?: readonly string[]; cache?: FingerprintCache } = {},
): Promise<CanvasOp[]> {
  const result = doc.results[id];
  if (!result) throw new Error(`Node ${id} has no images to blend again`);
  const fingerprint = await fingerprintAfter(doc, registry, ctx, id, patch, opts.cache);
  return [
    { op: "setParams", id, patch },
    { op: "setResult", id, result: reblended(result, fingerprint, opts.assetIds) },
  ];
}

function reblended(
  result: CanvasNodeResult,
  fingerprint: string,
  assetIds: readonly string[] | undefined,
): CanvasNodeResult {
  if (!assetIds) return { ...result, fingerprint };
  // One image stands in for another in place: what each was made from stays with it.
  const swap = new Map(result.assetIds.map((from, i) => [from, assetIds[i] ?? from]));
  return {
    ...result,
    fingerprint,
    assetIds: [...assetIds],
    outputs: result.outputs.map((o) => ({ ...o, assetId: swap.get(o.assetId) ?? o.assetId })),
  };
}
