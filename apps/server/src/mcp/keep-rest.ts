import {
  canReblend,
  editKeepRestOf,
  editSpec,
  fingerprintAfter,
  fromDocument,
  isLocked,
  KEEP_REST_PARAMS,
  keepRestBody,
  sameKeepRest,
  specRegistry,
} from "@openfield/canvas";
import type { KeepRestState } from "@openfield/core";
import type { CanvasDocument } from "@openfield/core/canvas";
import { getCanvas, listCanvases } from "@openfield/db";
import { readDocument } from "../canvas/documents";
import { ApiFailure } from "../http/errors";
import { actorOf, evaluateCanvas } from "./canvas";
import type { ToolContext } from "./kit";

// Keep the rest after an edit, for agents (§0.9). An edit keeps the model's own result, so how the
// rest is kept can change afterwards for free: the image is blended again in place. On a canvas an
// Edit node does that when only those settings change, and stays done; the nodes after it read an
// image that changed, so they go out of date.

/** An edit's keep-the-rest state, as an agent reads it. */
export function keepRestView(state: KeepRestState) {
  return {
    available: state.available,
    ...(state.note && { note: state.note }),
    on: state.keep,
    mode: state.mode,
    sensitivity: state.sensitivity,
    expandPx: state.expandPx,
    featherPx: state.featherPx,
    startsFrom: state.start,
    ...(state.lineUp && { lineUp: state.lineUp }),
    fellBack: state.fellBack,
    changed: state.changed,
    touchedUp: state.fixesUrl !== null,
    ...(state.modelResult?.savedAs && { modelResultSavedAs: state.modelResult.savedAs }),
  };
}

/** The keep-the-rest state of an edit, or nothing for an image that isn't one. */
export function keepRestOf(ctx: ToolContext, assetId: string) {
  const state = ctx.svc.keepRest.state(assetId);
  return state.unavailable === "not_an_edit" ? undefined : keepRestView(state);
}

export interface NodeHolding {
  canvasId: string;
  canvasName: string;
  nodeId: string;
  /** An Edit node whose own result this is. */
  edit: boolean;
  locked: boolean;
}

/** Canvas nodes with this image as their result. There's no index, so every canvas is read. */
export function nodesHolding(ctx: ToolContext, assetId: string): NodeHolding[] {
  const found: NodeHolding[] = [];
  for (const listed of listCanvases(ctx.svc.db)) {
    const row = getCanvas(ctx.svc.db, listed.id);
    if (!row) continue;
    const { slice } = fromDocument(readDocument(row.graph));
    for (const [nodeId, result] of Object.entries(slice.results)) {
      if (!result?.assetIds.includes(assetId)) continue;
      found.push({
        canvasId: row.id,
        canvasName: row.name,
        nodeId,
        edit: slice.nodes[nodeId]?.type === editSpec.type,
        locked: isLocked(slice, nodeId),
      });
    }
  }
  return found;
}

/**
 * After an agent's edits, Edit nodes that changed only how they keep the rest, and that were up to
 * date before, get their images blended again on the server and stay done. What happened to each,
 * in words for the agent.
 */
export async function settleKeepRest(
  ctx: ToolContext,
  canvasId: string,
  before: CanvasDocument,
  touched: readonly string[],
): Promise<string[]> {
  const was = fromDocument(before).slice;
  const ids = touched.filter((id) => was.nodes[id]?.type === editSpec.type && was.results[id]);
  if (!ids.length) return [];
  const row = getCanvas(ctx.svc.db, canvasId);
  if (!row) return [];
  const { slice, engine, fingerprints, evaluation } = await evaluateCanvas(ctx, readDocument(row.graph));
  const notes: string[] = [];
  const ops = [];
  for (const id of ids) {
    const result = slice.results[id];
    const old = editKeepRestOf(was.params[id] ?? {}, engine);
    const now = editKeepRestOf(slice.params[id] ?? {}, engine);
    if (!result || sameKeepRest(old, now)) continue;
    // With its old keep-the-rest settings back, a node that only changed those is as it ran.
    const back = Object.fromEntries(KEEP_REST_PARAMS.map((key) => [key, was.params[id]?.[key]]));
    const asRan = await fingerprintAfter(slice, specRegistry, engine, id, back);
    if (!canReblend(slice, id, asRan, evaluation.nodes.get(id)?.inputsChanged ?? false)) continue;
    if (!now.keep) {
      notes.push(
        `${id}: Keep the rest is off now, so the node is out of date and its next Run makes a new image (billed). To have the model's own result now, for free, call save_model_result with its image.`,
      );
      continue;
    }
    try {
      for (const assetId of result.assetIds) await ctx.svc.keepRest.apply(assetId, keepRestBody(now));
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      notes.push(
        `${id}: its images couldn't be blended again (${error.userMessage ?? error.message}), so the node is out of date and runs again on the next Run.`,
      );
      continue;
    }
    ops.push({ op: "setResult" as const, id, result: { ...result, fingerprint: fingerprints[id]! } });
    notes.push(
      `${id}: blended its images again with the new settings, for free, so it's still done. The nodes after it are out of date until they run again.`,
    );
  }
  if (ops.length) {
    try {
      ctx.svc.canvases.applyOps(canvasId, ops, actorOf(ctx), { graphVersion: row.graphVersion });
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 409) throw error;
      // The images did change; the canvas changed meanwhile, so those nodes show as out of date.
      return [
        ...notes,
        "The canvas changed meanwhile, so those nodes show as out of date. A Run brings them back.",
      ];
    }
  }
  return notes;
}
