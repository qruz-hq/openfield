import { CANVAS_PREVIEW_MAX_NODES } from "@openfield/core";
import type { CanvasNodeResult } from "@openfield/core/canvas";
import { nodeRegistry } from "../nodes/registry";
import { absolutePosition, type DocSlice } from "../store";
import { flowSize } from "./flow/adapter";
import { type Box, unionBox } from "./geometry";

// When the index card picture is retaken (M4-15, §7.3). After a save, when the canvas's outline
// changed noticeably or its results did (images arrived, a node failed), and a minute has passed
// since the last picture. Leaving the editor takes a picture that's due at once: the minute is
// there to avoid repeats, not to skip the last change. No React here, so it's tested on its own.

export const MIN_INTERVAL_MS = 60_000;
/** Outline changes smaller than this share of its size don't count. */
const MATERIAL = 0.1;

/** What a picture shows, reduced to what decides whether it's out of date. */
export interface CaptureShape {
  bounds: Box;
  count: number;
  /** Every node's result, as far as the card can show it: its state and images. */
  results: string;
}

export function docBounds(doc: DocSlice): Box | null {
  const boxes: Box[] = [];
  for (const id of doc.order) {
    const frame = doc.nodes[id];
    if (!frame) continue;
    const { width = 200, height = 120 } = flowSize(frame, nodeRegistry.get(frame.type));
    const at = absolutePosition(doc, id);
    boxes.push({ x: at.x, y: at.y, w: width, h: height });
  }
  return unionBox(boxes);
}

export function outlineChanged(before: Box | null, after: Box): boolean {
  if (!before) return true;
  const dw = Math.max(before.w, after.w, 1) * MATERIAL;
  const dh = Math.max(before.h, after.h, 1) * MATERIAL;
  return (
    Math.abs(before.x - after.x) > dw ||
    Math.abs(before.y - after.y) > dh ||
    Math.abs(before.w - after.w) > dw ||
    Math.abs(before.h - after.h) > dh
  );
}

const resultKey = (result: CanvasNodeResult | null | undefined) =>
  result ? `${result.state}:${result.assetIds.join(",")}` : "";

/** Null when there's no picture to take: an empty canvas, or one past the node limit. */
export function captureShape(doc: DocSlice): CaptureShape | null {
  const count = doc.order.length;
  if (!count || count > CANVAS_PREVIEW_MAX_NODES) return null;
  const bounds = docBounds(doc);
  if (!bounds) return null;
  const results = doc.order.map((id) => `${id}=${resultKey(doc.results[id])}`).join("|");
  return { bounds, count, results };
}

export function captureDue(last: CaptureShape | null, now: CaptureShape): boolean {
  return (
    !last ||
    last.count !== now.count ||
    last.results !== now.results ||
    outlineChanged(last.bounds, now.bounds)
  );
}

/**
 * The picture the index has when the editor opens: taken at `previewAt`, of the canvas as it
 * opens, unless results arrived after it (a run finished with the editor closed), or there's none.
 */
export function openingCapture(
  doc: DocSlice,
  previewAt: string | null,
): (CaptureShape & { at: number }) | null {
  if (!previewAt) return null;
  const shape = captureShape(doc);
  if (!shape) return null;
  const newer = doc.order.some((id) => {
    const ranAt = doc.results[id]?.ranAt;
    return !!ranAt && ranAt > previewAt;
  });
  return newer ? null : { ...shape, at: Date.parse(previewAt) };
}

export interface CaptureSchedulerDeps {
  /** What the canvas looks like now, or null when there's nothing to take. */
  shape(): CaptureShape | null;
  /** Take a picture of this; call finished() when it's stored or failed. */
  start(shape: CaptureShape): void;
  /** Left the editor and nothing more is due: the picture's host can go. */
  idle(): void;
  initial?: (CaptureShape & { at: number }) | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CaptureScheduler {
  /** After each save. */
  request(): void;
  finished(ok: boolean): void;
  /** The editor is open (again). */
  resume(): void;
  /** The editor closed: take what's due now. */
  leave(): void;
}

export function createCaptureScheduler(deps: CaptureSchedulerDeps): CaptureScheduler {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let last: (CaptureShape & { at: number }) | null = deps.initial ?? null;
  let timer: unknown = null;
  let running: CaptureShape | null = null;
  /** A save came in while a picture was being taken: look again once it's done. */
  let wanted = false;
  let leaving = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const request = () => {
    if (running) {
      wanted = true;
      return;
    }
    const shape = deps.shape();
    if (!shape || !captureDue(last, shape)) {
      if (leaving) deps.idle();
      return;
    }
    const wait = leaving || !last ? 0 : last.at + MIN_INTERVAL_MS - now();
    if (wait > 0) {
      timer ??= setTimer(() => {
        timer = null;
        request();
      }, wait);
      return;
    }
    cancelTimer();
    running = shape;
    deps.start(shape);
  };

  return {
    request,
    finished(ok) {
      if (ok && running) last = { ...running, at: now() };
      running = null;
      // Once is enough on the way out: a picture that failed isn't retried after the editor closed.
      if (!ok && leaving) return deps.idle();
      if (wanted || leaving) {
        wanted = false;
        request();
      }
    },
    resume() {
      leaving = false;
    },
    leave() {
      leaving = true;
      cancelTimer();
      if (!running) request();
    },
  };
}
