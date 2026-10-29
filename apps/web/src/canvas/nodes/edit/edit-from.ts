import { placeNode } from "@openfield/canvas/edits/place";
import type { EngineContext } from "@openfield/canvas/engine/types";
import { assetsSpec } from "@openfield/canvas/nodes/assets/spec";
import { editSpec } from "@openfield/canvas/nodes/edit/spec";
import { cardBox } from "@openfield/canvas/nodes/generate/card-size";
import { absolutePosition, isLocked, newEdgeId } from "@openfield/canvas/store/graph";
import { applyOps, type CanvasOp, type DocSlice, type Point } from "@openfield/canvas/store/ops";
import type { CanvasNode } from "@openfield/core/canvas";
import { useEngineStore } from "../../engine/engine-store";
import { cardMedia } from "../generate/card-media";
import type { NodeRegistry } from "../registry";

// The node menu's Edit (design UgTpM6ixP2, screens "Edit from an image node" and "New Edit node"):
// a new Edit node 140 to the right of the one whose image it edits, tops aligned, already wired, in
// one undo step. A mask fits one image, so the Edit node gets the image on show and keeps it: from a
// node that shows several, or one whose next run makes a new one (changed, or a model that makes a
// new image every run), an Assets node holds that image between the two. Pure apart from reading
// the card media and the live analysis, so the plan is tested.

/** The images a node hands on: what it made, else the ones it holds (Upload, Assets). */
export function imagesOf(doc: DocSlice, id: string): readonly string[] {
  const made = doc.results[id]?.assetIds ?? [];
  if (made.length) return made;
  const own = doc.params[id]?.assetIds;
  return Array.isArray(own) ? own.filter((a): a is string => typeof a === "string") : [];
}

/** The node's image output, when it has one and something on it to edit. */
export function editableOutput(doc: DocSlice, registry: NodeRegistry, id: string): string | null {
  const frame = doc.nodes[id];
  const def = frame ? registry.get(frame.type) : undefined;
  const port = def?.ports.find((p) => p.direction === "out" && p.type === "image" && !p.hidden);
  return port && imagesOf(doc, id).length > 0 ? port.id : null;
}

export interface EditFromPlan {
  ops: CanvasOp[];
  /** The new Edit node. */
  editId: string;
}

/** From the source's right edge to the new node (design blc5dYrGqG). */
const EDIT_GAP = 140;

/**
 * The ops that add an Edit node for `sourceId`'s image on show, or null when it has none. `shown`
 * is the image its card shows (the pager's pick); `sizes` the images' sizes, for the new card's
 * shape and to keep clear of its neighbours; `upToDate` whether a run would leave the source's
 * images as they are (its live analysis).
 */
export function planEditFrom(input: {
  doc: DocSlice;
  registry: NodeRegistry;
  ctx: EngineContext;
  sourceId: string;
  shown?: string | undefined;
  sizes: Readonly<Record<string, { w: number; h: number }>>;
  upToDate?: boolean;
}): EditFromPlan | null {
  const { doc, registry, ctx, sourceId, sizes } = input;
  const source = doc.nodes[sourceId];
  const output = editableOutput(doc, registry, sourceId);
  if (!source || !output) return null;
  const images = imagesOf(doc, sourceId);
  const image = input.shown && images.includes(input.shown) ? input.shown : images[0]!;
  // New nodes go in the source's frame, unless that frame keeps its contents as they are.
  const parentId = source.parentId && !isLocked(doc, source.parentId) ? source.parentId : null;
  const origin = parentId ? absolutePosition(doc, parentId) : { x: 0, y: 0 };
  const ops: CanvasOp[] = [];
  let working = doc;
  const add = (node: CanvasNode, near: string) => {
    const at = placeNode(working, registry, {
      size: node.size ?? { w: 0, h: 0 },
      near,
      side: "right",
      parentId,
      source: { ctx, images: sizes },
      gap: EDIT_GAP,
      grid: false,
    });
    node.position = { x: Math.round(at.x - origin.x), y: Math.round(at.y - origin.y) };
    const op: CanvasOp = { op: "addNode", node };
    ops.push(op);
    working = applyOps(working, [op]).doc;
  };
  const link = (from: string, handle: string, to: string): CanvasOp => ({
    op: "addEdge",
    edge: {
      id: newEdgeId(),
      source: from,
      sourceHandle: handle,
      target: to,
      targetHandle: "image",
      kind: "data",
    },
  });

  let from = sourceId;
  let handle = output;
  // Upload and Assets nodes, locked nodes and up-to-date ones hand on the same image next run too.
  const runs = !!registry.get(source.type)?.runnable && !isLocked(doc, sourceId);
  const keeps = !runs || input.upToDate === true;
  if (images.length > 1 || !keeps) {
    // Several images, or one a run would replace (Run all would leave the mask on another image):
    // the one on show goes on alone, and stays.
    const pin = registry.instantiate(assetsSpec.type, { position: ORIGIN, ctx, parentId });
    pin.params = { assetIds: [image] };
    add(pin, sourceId);
    from = pin.id;
    handle = "images";
  }
  const edit = registry.instantiate(editSpec.type, { position: ORIGIN, ctx, parentId });
  const size = sizes[image];
  // The card takes the image's shape from the start, so it's placed at the size it draws.
  if (size) {
    const box = cardBox(size.w / size.h);
    edit.size = { w: box.w, h: box.h };
  }
  add(edit, from);
  ops.push(link(from, handle, edit.id));
  return { ops, editId: edit.id };
}

const ORIGIN: Point = { x: 0, y: 0 };

/** The plan for the card as it shows now: its pager's pick and the image sizes the editor knows. */
export function planEditFromCard(
  doc: DocSlice,
  registry: NodeRegistry,
  ctx: EngineContext,
  sourceId: string,
): EditFromPlan | null {
  const media = cardMedia.getState();
  const upToDate = useEngineStore.getState().analysis.nodes[sourceId]?.upToDate ?? false;
  return planEditFrom({
    doc,
    registry,
    ctx,
    sourceId,
    shown: media.shown[sourceId],
    sizes: media.dims,
    upToDate,
  });
}
