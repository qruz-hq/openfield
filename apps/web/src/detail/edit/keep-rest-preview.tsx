import {
  DETAIL_PREVIEW_EDGE,
  KEEP_REST_FELL_BACK,
  type KeepRestState,
  type LineUp,
  marksArea,
  t,
} from "@openfield/core";
import { cn } from "@openfield/ui";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuthedImage } from "../../api/hooks/images";
import { keepRestAreaUrl } from "../../api/hooks/keep-rest";
import { rawFetch } from "../../api/raw";
import { LegendKey, legendClass } from "./compare";
import { type FixLayer, lineUpTransform, outlinePath, withFixCodes } from "./fix-layer";

// The live preview of Keep the rest after a run (§0.9), drawn in the browser from the stored model
// result, so moving a slider or painting a stroke shows at once and costs nothing. The server's
// area map says where the model is used for the settings asked (its own fix layer baked in), and
// its headers how it decided; new strokes go on top here. Drawn at the detail preview's size.
//
// Everything here takes the edit's state, the settings and the fix layer as props, so the Edit tab
// and the canvas Edit node's window draw the same preview.
//
// Off, the server saves the model's own result as it came, unmoved, with only "use the original"
// strokes putting the original back: maskOnlyWeights over the whole picture, no Expand or Feather.

/** Slider drags ask for a new area map once they rest this long. */
const AREA_DEBOUNCE_MS = 120;

/** The outline is traced at this long edge at most: plenty for a dashed line on screen. */
const OUTLINE_EDGE = 512;

/** Area maps kept decoded, for going back and forth between a few settings. */
const AREA_CACHE = 8;

/** The settings a preview is drawn for. */
export interface KeepRestValues {
  keep: boolean;
  sensitivity: number;
  featherPx: number;
  expandPx: number;
}

export interface PreviewInput {
  state: KeepRestState;
  values: KeepRestValues;
  /** Strokes on top of the stored layer, or null for the stored layer alone. */
  fixes: FixLayer | null;
  /** Goes up with each stroke, so the weights are read again. */
  fixesVersion: number;
}

/** The size the preview is drawn at: the original's, down to the detail preview's long edge. */
export function previewSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, DETAIL_PREVIEW_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** An image decoded and ready to draw, from a blob URL. The last one stays while the next decodes. */
function useDecoded(src: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImage(null);
      return;
    }
    let live = true;
    const next = new Image();
    next.src = src;
    next.decode().then(
      () => live && setImage(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [src]);
  return image;
}

/** A 2D context on a fresh canvas, for reading pixels. */
function scratch(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return context ? { canvas, context } : null;
}

type Move = Pick<LineUp, "dx" | "dy" | "scaleX" | "scaleY">;

/** An area map and how the server decided it, from the response headers. */
interface AreaMap {
  image: ImageBitmap;
  /** Undefined when the server didn't say: the last applied state stands in. */
  fellBack?: KeepRestState["fellBack"];
  lineUp?: Move | null;
}

const areas = new Map<string, Promise<AreaMap>>();

function parseFellBack(value: string | null): KeepRestState["fellBack"] | undefined {
  if (value === null) return undefined;
  if (value === "none") return null;
  return (KEEP_REST_FELL_BACK as readonly string[]).includes(value)
    ? (value as NonNullable<KeepRestState["fellBack"]>)
    : undefined;
}

function parseLineUp(value: string | null): Move | null | undefined {
  if (value === null) return undefined;
  if (value === "none") return null;
  const [dx, dy, scaleX, scaleY] = value.split(",").map(Number);
  if (dx === undefined || dy === undefined || scaleX === undefined || scaleY === undefined) return undefined;
  if (![dx, dy, scaleX, scaleY].every(Number.isFinite)) return undefined;
  return { dx, dy, scaleX, scaleY };
}

function loadArea(path: string): Promise<AreaMap> {
  let entry = areas.get(path);
  if (!entry) {
    entry = rawFetch(path).then(async (res) => {
      if (!res.ok) throw new Error(`Area ${res.status}`);
      return {
        image: await createImageBitmap(await res.blob()),
        fellBack: parseFellBack(res.headers.get("x-keep-rest-fell-back")),
        lineUp: parseLineUp(res.headers.get("x-keep-rest-line-up")),
      };
    });
    entry.catch(() => areas.delete(path));
    areas.set(path, entry);
    // The oldest go first; the browser's own cache answers them again by ETag.
    while (areas.size > AREA_CACHE) {
      const oldest = areas.keys().next().value;
      if (oldest === undefined) break;
      areas.delete(oldest);
    }
  }
  return entry;
}

/** The area map for `path`. The last one stays while the next loads. */
function useArea(path: string | null): AreaMap | null {
  const [area, setArea] = useState<AreaMap | null>(null);
  useEffect(() => {
    if (!path) {
      setArea(null);
      return;
    }
    let live = true;
    loadArea(path).then(
      (next) => live && setArea(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [path]);
  return area;
}

export interface PreviewWeights {
  /** One byte per pixel of the preview: 255 the model, 0 the original. */
  weights: Uint8ClampedArray;
  width: number;
  height: number;
  /** How the result is moved before it's laid over, as the server would for these settings. */
  lineUp: Move | null;
  /** Why the mask alone decided, for these settings. */
  fellBack: KeepRestState["fellBack"];
}

/** Where the model is used for the draft's settings and strokes. Null until the area map is in. */
export function usePreviewWeights({
  state,
  values,
  fixes,
  fixesVersion,
}: PreviewInput): PreviewWeights | null {
  const { width, height } = previewSize(state.base?.width ?? 1, state.base?.height ?? 1);
  const settings = useDebounced(
    `${values.sensitivity}|${values.featherPx}|${values.expandPx}`,
    AREA_DEBOUNCE_MS,
  );
  const areaPath = useMemo(() => {
    if (!values.keep) return null;
    const [sensitivity, featherPx, expandPx] = settings.split("|").map(Number);
    return keepRestAreaUrl(state, { sensitivity, featherPx, expandPx });
  }, [state, settings, values.keep]);
  const area = useArea(areaPath);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fixesVersion stands for the fix layer's codes, which change in place.
  return useMemo(() => {
    let weights: Uint8ClampedArray;
    if (values.keep) {
      if (!area) return null;
      const pad = scratch(width, height);
      if (!pad) return null;
      pad.context.drawImage(area.image, 0, 0, width, height);
      const rgba = pad.context.getImageData(0, 0, width, height).data;
      weights = new Uint8ClampedArray(width * height);
      for (let p = 0; p < weights.length; p++) weights[p] = rgba[p * 4]!;
      if (fixes) withFixCodes(weights, width, height, fixes);
    } else {
      // The whole picture is the model's, but where a stroke says "use the original here".
      weights = new Uint8ClampedArray(width * height).fill(255);
      if (fixes) {
        const original = new Uint8ClampedArray(width * height).fill(255);
        withFixCodes(original, width, height, fixes);
        for (let p = 0; p < weights.length; p++) if (original[p] === 0) weights[p] = 0;
      }
    }
    // The server moves the result only when it kept the rest by comparing, never with the switch off.
    const fellBack = !values.keep ? null : area?.fellBack !== undefined ? area.fellBack : state.fellBack;
    const decided = area?.lineUp !== undefined ? area.lineUp : state.lineUp;
    const lineUp = values.keep && !fellBack && state.mode === "smart" ? decided : null;
    return { weights, width, height, lineUp, fellBack };
  }, [area, values.keep, fixes, fixesVersion, width, height, state.fellBack, state.lineUp, state.mode]);
}

/**
 * After, while the draft differs from what's saved: the original (`baseUrl`, any size of it) with
 * the model's result laid over it where the weights say, lined up as the server would.
 */
export function KeptPreview({ baseUrl, ...input }: PreviewInput & { baseUrl: string }) {
  const { state } = input;
  const canvas = useRef<HTMLCanvasElement>(null);
  const weights = usePreviewWeights(input);
  const base = useAuthedImage(baseUrl);
  const model = useAuthedImage(state.modelResult?.fittedUrl ?? null);
  const baseImage = useDecoded(base.status === "ready" ? base.src : null);
  const modelImage = useDecoded(model.status === "ready" ? model.src : null);
  const ready = !!weights && !!baseImage && !!modelImage;

  useLayoutEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context || !weights || !baseImage || !modelImage || !state.base) return;
    const { width, height } = weights;
    el.width = width;
    el.height = height;
    context.drawImage(baseImage, 0, 0, width, height);
    const layer = scratch(width, height);
    if (!layer) return;
    layer.context.setTransform(
      ...lineUpTransform(weights.lineUp, state.base.width, state.base.height, width / state.base.width),
    );
    layer.context.drawImage(modelImage, 0, 0, state.base.width, state.base.height);
    layer.context.setTransform(1, 0, 0, 1, 0, 0);
    const pixels = layer.context.getImageData(0, 0, width, height);
    const data = pixels.data;
    for (let p = 0; p < weights.weights.length; p++)
      data[p * 4 + 3] = (data[p * 4 + 3]! * weights.weights[p]!) / 255;
    layer.context.putImageData(pixels, 0, 0);
    context.drawImage(layer.canvas, 0, 0);
  }, [weights, baseImage, modelImage, state.base]);

  return (
    <canvas
      ref={canvas}
      data-keep-preview
      data-ready={ready ? "" : undefined}
      className={cn("absolute inset-0 size-full", !ready && "invisible")}
    />
  );
}

/** The area the edit started from, inside 255, at a small size for tracing. */
function useStartArea(state: KeepRestState): { inside: Uint8Array; width: number; height: number } | null {
  const full = state.base ?? { width: 1, height: 1 };
  const scale = Math.min(1, OUTLINE_EDGE / Math.max(full.width, full.height));
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const mask = useAuthedImage(state.start === "mask" ? (state.mask?.url ?? null) : null);
  const maskImage = useDecoded(mask.status === "ready" ? mask.src : null);
  return useMemo(() => {
    if (state.start === "marks" && state.marks) {
      return { inside: marksArea(state.marks, width, height), width, height };
    }
    if (!maskImage) return null;
    const pad = scratch(width, height);
    if (!pad) return null;
    pad.context.drawImage(maskImage, 0, 0, width, height);
    const rgba = pad.context.getImageData(0, 0, width, height).data;
    // A mask is transparent where it may change.
    const inside = new Uint8Array(width * height);
    for (let p = 0; p < inside.length; p++) inside[p] = rgba[p * 4 + 3]! < 128 ? 255 : 0;
    return { inside, width, height };
  }, [state.start, state.marks, maskImage, width, height]);
}

/**
 * Difference and Touch up after a run (design HkxoDIbrAz, YYkh7rc2sd): where each part comes from.
 * The original dimmed with the canvas tone at 82%, the model's areas in the accent at 85% with a 7px
 * blur, and the mask the edit started from as a dashed outline. `children` go on top: the brush.
 */
export function SourcesLayer({ children, ...input }: PreviewInput & { children?: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const weights = usePreviewWeights(input);
  const start = useStartArea(input.state);
  const outline = useMemo(() => (start ? outlinePath(start.inside, start.width, start.height) : ""), [start]);

  // White with the weights as alpha, then the accent through it: the canvas's own colour is the token.
  useLayoutEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context || !weights) return;
    el.width = weights.width;
    el.height = weights.height;
    const pixels = context.createImageData(weights.width, weights.height);
    for (let p = 0; p < weights.weights.length; p++) {
      pixels.data[p * 4] = 255;
      pixels.data[p * 4 + 1] = 255;
      pixels.data[p * 4 + 2] = 255;
      pixels.data[p * 4 + 3] = weights.weights[p]!;
    }
    context.putImageData(pixels, 0, 0);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = getComputedStyle(el).color;
    context.fillRect(0, 0, el.width, el.height);
    context.globalCompositeOperation = "source-over";
  }, [weights]);

  return (
    <div data-paint="dark" data-sources className="absolute inset-0">
      {/* From the original */}
      <div className="absolute inset-0 bg-canvas opacity-82" />
      {/* From the model */}
      <canvas
        ref={canvas}
        data-from-model
        data-ready={weights ? "" : undefined}
        className={cn(
          "absolute inset-0 size-full text-accent opacity-85 blur-[7px]",
          !weights && "invisible",
        )}
      />
      {/* Your mask */}
      {start && outline ? (
        <svg
          aria-hidden
          data-start-outline
          viewBox={`0 0 ${start.width} ${start.height}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full"
        >
          <path
            d={outline}
            className="fill-none stroke-text-secondary"
            style={{ strokeWidth: 1.5, strokeDasharray: "5 4" }}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Image edit / Difference legend / Sources (design zHw4FEnWur), with SourcesLayer: the model's
 * areas, the original's, and the area the edit started from, dashed. Under the image by default.
 */
export function SourcesLegend({ marks = false, className }: { marks?: boolean; className?: string }) {
  return (
    <div data-paint="dark" className={cn(legendClass, className)}>
      <LegendKey swatch="bg-accent" label={t("edit.compare.fromModel")} />
      <LegendKey
        swatch="bg-canvas inset-ring inset-ring-border-strong"
        label={t("edit.compare.fromOriginal")}
      />
      <LegendKey
        swatch={
          <svg aria-hidden viewBox="0 0 8 8" className="size-8 shrink-0 overflow-visible">
            <circle
              cx={4}
              cy={4}
              r={3.5}
              className="fill-none stroke-text-secondary"
              style={{ strokeWidth: 1, strokeDasharray: "2 1.5" }}
            />
          </svg>
        }
        label={t(marks ? "edit.compare.yourMarks" : "edit.compare.yourMask")}
      />
    </div>
  );
}
