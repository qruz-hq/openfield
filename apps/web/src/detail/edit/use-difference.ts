import { useEffect, useState } from "react";
import { type DifferenceRequest, drawDifference, type PixelSize } from "./difference";
import type { DifferenceMessage, DifferenceReply } from "./difference.worker";

// The Difference view's mask, worked out in a worker (difference.worker.ts). A browser without
// workers or OffscreenCanvas works it out on the page instead, as does a request in flight when the
// worker itself fails to load. The last few masks are kept, so flipping between Before and after and
// Difference, or between new images, doesn't work them out again.

/** The change mask: white, with how much each pixel changed as its alpha. */
export type DifferenceMask = ImageBitmap | HTMLCanvasElement;

interface Waiting {
  request: DifferenceRequest;
  resolve: (mask: DifferenceMask) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, Waiting>();

function onPage(request: DifferenceRequest): Promise<DifferenceMask> {
  return drawDifference(request, (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }) as Promise<HTMLCanvasElement>;
}

function differenceWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const created = new Worker(new URL("./difference.worker.ts", import.meta.url), { type: "module" });
    created.onmessage = (event: MessageEvent<DifferenceReply>) => {
      const reply = event.data;
      const entry = waiting.get(reply.id);
      if (!entry) return;
      waiting.delete(reply.id);
      if ("mask" in reply) entry.resolve(reply.mask);
      else entry.reject(new Error(reply.error));
    };
    // The worker couldn't start: what it held is worked out on the page, and so is what comes next.
    created.onerror = () => {
      worker = null;
      created.terminate();
      for (const entry of waiting.values()) onPage(entry.request).then(entry.resolve, entry.reject);
      waiting.clear();
    };
    worker = created;
  } catch {
    worker = null;
  }
  return worker;
}

function compute(request: DifferenceRequest): Promise<DifferenceMask> {
  const target = differenceWorker();
  if (!target) return onPage(request);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { request, resolve, reject });
    target.postMessage({ id, ...request } satisfies DifferenceMessage);
  });
}

const KEPT = 4;
const kept = new Map<string, Promise<DifferenceMask>>();

const blobOf = (url: string) => fetch(url).then((res) => res.blob());

/** The mask for two images (their blob URLs) shown at `shown` device pixels. */
function differenceOf(before: string, after: string, shown: PixelSize): Promise<DifferenceMask> {
  const key = `${before}|${after}|${shown.width}x${shown.height}`;
  const hit = kept.get(key);
  if (hit) {
    kept.delete(key);
    kept.set(key, hit);
    return hit;
  }
  const mask = Promise.all([blobOf(before), blobOf(after)]).then(([a, b]) =>
    compute({ before: a, after: b, shown }),
  );
  kept.set(key, mask);
  mask.catch(() => kept.delete(key));
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) break;
    kept.delete(old);
  }
  return mask;
}

/** A window being resized sends a size per frame: only the one it settles on is worked out. */
const SETTLE_MS = 150;

/**
 * The change mask between two images (blob URLs, null while they load) shown at `shown` device
 * pixels. Null until the first one is in; after that a new size keeps the old mask, stretched, until
 * its own is ready. A mask for other images is never shown.
 */
export function useDifference(
  before: string | null,
  after: string | null,
  shown: PixelSize | null,
): DifferenceMask | null {
  const [state, setState] = useState<{ pair: string; mask: DifferenceMask } | null>(null);
  const width = shown ? Math.round(shown.width) : 0;
  const height = shown ? Math.round(shown.height) : 0;
  const pair = before && after ? `${before}|${after}` : null;
  const settled = state !== null && state.pair === pair;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `settled` only sets the wait.
  useEffect(() => {
    if (!before || !after || !pair || width <= 0 || height <= 0) return;
    let live = true;
    const timer = setTimeout(
      () => {
        differenceOf(before, after, { width, height }).then(
          (mask) => live && setState({ pair, mask }),
          // Both previews are already on screen, so this hardly happens. Nothing is marked then.
          () => {},
        );
      },
      settled ? SETTLE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [before, after, pair, width, height]);

  return settled ? state.mask : null;
}
