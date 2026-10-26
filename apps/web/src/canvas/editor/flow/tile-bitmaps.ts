import { pickThumbSize, thumbPixels } from "@openfield/core";
import { rawFetch } from "../../../api/raw";
import { thumbUrl } from "../../nodes/shell/thumb";

// The images the zoomed-out canvas layer paints (canvas-layer.tsx). Each is fetched once at the
// smallest thumbnail that covers it (pickThumbSize), decoded once and scaled down to about the size
// it's drawn at, so a frame only copies small, ready pixels. Kept by recency within a memory budget;
// the compressed file stays too, so zooming in redecodes a sharper copy without fetching again.

/** Something drawImage takes: a decoded bitmap, or a canvas holding a scaled-down copy. */
export type Drawable = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

interface Entry {
  file: Blob | null;
  /** The thumbnail fetched, in device pixels tall. */
  filePixels: number;
  image: Drawable | null;
  /** The drawn height `image` is sharp up to, in device pixels. */
  pixels: number;
  bytes: number;
  /** A fetch or decode is under way for this height. */
  pending: number;
  failed: boolean;
  /** The frame it was last drawn in. */
  used: number;
}

/** Decoded pixels kept, in bytes. */
const BUDGET = 160 * 1024 * 1024;
/** Fetches and decodes at once: enough to fill a screen quickly without starving the editor. */
const PARALLEL = 6;
/** Decoded copies come in powers of two from here, so a zoom redecodes a tile only now and then. */
const SMALLEST = 32;

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, SMALLEST)));

export interface TileBitmaps {
  /**
   * The image to paint for an asset drawn `pixels` tall on screen. Whatever is ready comes back at
   * once (null when nothing is); a sharper copy is asked for when this one is too small.
   */
  get(assetId: string, pixels: number): Drawable | null;
  /** Loads images ahead of time, in this order, behind anything on screen. */
  prefetch(items: readonly { assetId: string; pixels: number }[]): void;
  /** The next frame's number: images drawn in it are never let go to make room. */
  frame(): void;
  /** Called after an image becomes ready. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createTileBitmaps(): TileBitmaps {
  const entries = new Map<string, Entry>();
  const urgent = new Map<string, number>();
  const later = new Map<string, number>();
  const listeners = new Set<() => void>();
  let running = 0;
  let bytes = 0;
  let frameNo = 0;
  let disposed = false;

  const entry = (assetId: string): Entry => {
    let e = entries.get(assetId);
    if (!e) {
      e = { file: null, filePixels: 0, image: null, pixels: 0, bytes: 0, pending: 0, failed: false, used: 0 };
      entries.set(assetId, e);
    }
    return e;
  };

  const release = (e: Entry) => {
    if (e.image && "close" in e.image) e.image.close();
    bytes -= e.bytes;
    e.image = null;
    e.bytes = 0;
    e.pixels = 0;
  };

  /** Lets go of the least recently drawn images until the budget holds. */
  const trim = () => {
    if (bytes <= BUDGET) return;
    for (const [id, e] of entries) {
      if (bytes <= BUDGET) break;
      if (e.used >= frameNo || e.pending) continue;
      release(e);
      entries.delete(id);
    }
  };

  /** Whether `e` already shows `want` pixels sharply, or can't get any sharper. */
  const sharp = (e: Entry, want: number) => e.failed || (e.image !== null && e.pixels >= want);

  async function load(assetId: string, want: number) {
    const e = entry(assetId);
    const height = pow2(want);
    e.pending = height;
    try {
      const size = pickThumbSize(height);
      if (!e.file || e.filePixels < Math.min(height, thumbPixels(size))) {
        const res = await rawFetch(thumbUrl(assetId, size));
        if (!res.ok) throw new Error(`Image ${res.status}`);
        e.file = await res.blob();
        e.filePixels = thumbPixels(size);
      }
      const image = await decode(e.file, height);
      if (disposed) return void close(image.image);
      release(e);
      e.image = image.image;
      // Sharp enough for this height even when the picture itself is smaller.
      e.pixels = height;
      e.bytes = image.bytes;
      bytes += image.bytes;
      entries.delete(assetId);
      entries.set(assetId, e);
      trim();
      for (const listener of listeners) listener();
    } catch {
      e.failed = true;
    } finally {
      e.pending = 0;
    }
  }

  const pump = () => {
    while (running < PARALLEL && !disposed) {
      const queue = urgent.size ? urgent : later;
      const next = queue.entries().next();
      if (next.done) return;
      const [assetId, want] = next.value;
      queue.delete(assetId);
      const e = entries.get(assetId);
      if (e && (sharp(e, want) || e.pending >= want)) continue;
      running++;
      void load(assetId, want).finally(() => {
        running--;
        pump();
      });
    }
  };

  const ask = (queue: Map<string, number>, assetId: string, pixels: number) => {
    const e = entries.get(assetId);
    if (e && (sharp(e, pixels) || e.pending >= pixels)) return;
    queue.set(assetId, Math.max(queue.get(assetId) ?? 0, pixels));
  };

  return {
    get(assetId, pixels) {
      const e = entries.get(assetId);
      if (e) e.used = frameNo;
      if (!e || !sharp(e, pixels)) {
        ask(urgent, assetId, pixels);
        pump();
      }
      return e?.image ?? null;
    },
    prefetch(items) {
      for (const { assetId, pixels } of items) ask(later, assetId, pixels);
      pump();
    },
    frame() {
      frameNo++;
      // What was asked for last frame and not started yet may be off screen now.
      urgent.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const e of entries.values()) release(e);
      entries.clear();
      urgent.clear();
      later.clear();
      listeners.clear();
    },
  };
}

const close = (image: Drawable) => {
  if ("close" in image) image.close();
};

/**
 * The file decoded, scaled down to `height` device pixels when it's well over that. Safari 16 has
 * createImageBitmap but not its resize options, so the scaling goes through a canvas.
 */
async function decode(file: Blob, height: number): Promise<{ image: Drawable; bytes: number }> {
  let source: ImageBitmap | HTMLImageElement;
  if (typeof createImageBitmap === "function") source = await createImageBitmap(file);
  else {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const w = "naturalWidth" in source ? source.naturalWidth : source.width;
  const h = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (h <= height * 1.5) return { image: source, bytes: w * h * 4 };
  const scale = height / h;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { image: source, bytes: w * h * 4 };
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  close(source);
  return { image: canvas, bytes: canvas.width * canvas.height * 4 };
}
