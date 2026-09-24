import { type CanvasEdge, type CanvasNode, canvasEdgeSchema, canvasNodeSchema } from "@openfield/core/canvas";
import { CANVAS_FRAGMENT_KIND, type CanvasFragment, isCanvasFragment } from "../store";

// Copy and paste (§7.9). The selection travels as JSON under application/json with the same text
// under text/plain, so it pastes into another canvas, another window, or a text editor and back.

export const FRAGMENT_MIME = "application/json";

/** What goes on the clipboard: the fragment plus where it came from, for the +24 paste offset. */
export interface ClipboardPayload extends CanvasFragment {
  canvasId?: string;
}

export function serializeFragment(fragment: CanvasFragment, canvasId: string): string {
  const payload: ClipboardPayload = { ...fragment, canvasId };
  return JSON.stringify(payload);
}

/**
 * Reads a pasted payload. Anything that isn't a canvas fragment, or whose nodes don't parse,
 * comes back null so a stray paste never lands half a graph.
 */
export function parseFragment(text: string | null | undefined): ClipboardPayload | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isCanvasFragment(value)) return null;
  const nodes: CanvasNode[] = [];
  for (const raw of value.nodes) {
    const parsed = canvasNodeSchema.safeParse(raw);
    if (!parsed.success) return null;
    nodes.push(parsed.data);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: CanvasEdge[] = [];
  for (const raw of value.edges) {
    const parsed = canvasEdgeSchema.safeParse(raw);
    if (parsed.success && ids.has(parsed.data.source) && ids.has(parsed.data.target)) edges.push(parsed.data);
  }
  // A frame that didn't come along can't be a parent here.
  const fixed = nodes.map((n) => (n.parentId && !ids.has(n.parentId) ? { ...n, parentId: null } : n));
  const canvasId = (value as ClipboardPayload).canvasId;
  return {
    kind: CANVAS_FRAGMENT_KIND,
    nodes: fixed,
    edges,
    ...(typeof canvasId === "string" && { canvasId }),
  };
}

/** Consecutive pastes of the same copy step down and right, 24 at a time. */
export const PASTE_STEP = 24;
