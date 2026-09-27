import { PULSE } from "../../../editor/flow/pulse";
import { VOXEL_SWARM_GLSL } from "./shader";

// One WebGL context draws every generating card's voxels: browsers allow only a handful of contexts,
// and a canvas can have many cards running. It renders one fragment per 4 px cell into a small
// shared canvas, and each card copies its patch onto its own 2D canvas, scaled up without smoothing,
// with the 1 px gaps cut out. One animation frame loop at about 30 fps draws the cards on screen, and
// stops once none is left to animate.

/** Cell pitch and gap in canvas units, so they scale with zoom like the rest of the card. */
export const CELL = 4;
const GAP = 1;
const FRAME_MS = 1000 / 30;
/** The shader's clock wraps here, a whole number of link cycles and pocket periods, to stay small. */
const WRAP_S = 2400;
// The design's timing (motion spec oQ27O), on the links' own clock (pulse.ts), so puffs land with them.
const PERIOD_S = 3.2;
const LINK_S = PULSE.cycleMs / 1000;
const ARRIVE_S = PULSE.travelMs / 1000;
const SETTLE_S = LINK_S;
/** Reduced motion holds this moment of the swarm. */
const STILL_PHASE = 0.3;
const BACKING = 0.72;

export interface VoxelParams {
  /** Generating runs the swarm and takes puffs; waiting idles it. */
  mode: "active" | "idle";
  /** Each card its own sky: a whole number, 0 to 999. */
  seed: number;
  /** Connected input ports, as shares of the card's height from the top. At most three count. */
  ports: readonly number[];
  /** Over an image: a dark cell under each lit one, so the swarm still reads. */
  backing: boolean;
  /** When the first link pulse lands, in ms on performance.now()'s clock. Null takes any. */
  firstMs: number | null;
  /** Reduced motion: one still frame. */
  still: boolean;
}

export interface VoxelHandle {
  update(params: VoxelParams, cols: number, rows: number): void;
  remove(): void;
}

type Rgb = [number, number, number];

interface Target {
  canvas: HTMLCanvasElement;
  params: VoxelParams;
  cols: number;
  rows: number;
  visible: boolean;
  colors: { color: Rgb; dark: Rgb } | null;
  drawn: boolean;
}

const UNIFORMS = [
  "u_resolution",
  "u_time",
  "u_color",
  "u_dark",
  "u_mode",
  "u_cells",
  "u_period",
  "u_link",
  "u_arrive",
  "u_settle",
  "u_seed",
  "u_ports",
  "u_backing",
  "u_phase",
  "u_first",
] as const;

type Uniform = (typeof UNIFORMS)[number];

interface Gl {
  context: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  at: Record<Uniform, WebGLUniformLocation | null>;
}

/** Undefined until first asked; null when this browser can't draw it (the card keeps its glyph). */
let gl: Gl | null | undefined;
const targets = new Set<Target>();
const patterns = new Map<string, CanvasPattern | null>();
let frame = 0;
let last = 0;
let observer: IntersectionObserver | null = null;
let themeWatch: (() => void) | null = null;

/** True when the voxels can be drawn here. Sets WebGL up the first time. */
export function voxelsSupported(): boolean {
  return setup() !== null;
}

/** Starts drawing a card's voxels onto its canvas. Null when WebGL isn't available. */
export function attachVoxels(
  canvas: HTMLCanvasElement,
  params: VoxelParams,
  cols: number,
  rows: number,
): VoxelHandle | null {
  if (!setup()) return null;
  const target: Target = { canvas, params, cols, rows, visible: true, colors: null, drawn: false };
  targets.add(target);
  watch(target);
  schedule();
  return {
    update(next, c, r) {
      target.params = next;
      target.cols = c;
      target.rows = r;
      target.drawn = false;
      schedule();
    },
    remove() {
      targets.delete(target);
      observer?.unobserve(canvas);
      if (!targets.size) stopWatching();
    },
  };
}

function setup(): Gl | null {
  if (gl === undefined) gl = create();
  return gl;
}

function create(): Gl | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!context) return null;
  const program = link(context);
  if (!program) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
  context.useProgram(program);
  // One triangle that covers the viewport.
  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
  const position = context.getAttribLocation(program, "a_position");
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
  const at = Object.fromEntries(UNIFORMS.map((name) => [name, context.getUniformLocation(program, name)]));
  // A lost context isn't brought back: the cards simply stop drawing their voxels.
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    gl = null;
  });
  return { context, canvas, at: at as Gl["at"] };
}

function link(context: WebGLRenderingContext): WebGLProgram | null {
  const shader = (type: number, source: string) => {
    const s = context.createShader(type);
    if (!s) return null;
    context.shaderSource(s, source);
    context.compileShader(s);
    return context.getShaderParameter(s, context.COMPILE_STATUS) ? s : null;
  };
  const vertex = shader(
    context.VERTEX_SHADER,
    "attribute vec2 a_position; void main() { gl_Position = vec4(a_position, 0.0, 1.0); }",
  );
  const fragment = shader(context.FRAGMENT_SHADER, VOXEL_SWARM_GLSL);
  if (!vertex || !fragment) return null;
  const program = context.createProgram();
  if (!program) return null;
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  return context.getProgramParameter(program, context.LINK_STATUS) ? program : null;
}

function schedule() {
  if (!frame && targets.size) frame = requestAnimationFrame(tick);
}

function tick(now: number) {
  frame = 0;
  if (!gl || !targets.size) return;
  let animating = false;
  if (now - last >= FRAME_MS - 2) {
    last = now;
    for (const target of targets) {
      if (!target.visible) continue;
      if (!target.params.still || !target.drawn) draw(gl, target, now);
    }
  }
  for (const target of targets) if (!target.params.still || !target.drawn) animating = true;
  if (animating) frame = requestAnimationFrame(tick);
}

function draw({ context, canvas: shared, at }: Gl, target: Target, nowMs: number) {
  const { cols, rows, params, canvas } = target;
  if (cols < 1 || rows < 1) return;
  if (shared.width < cols || shared.height < rows) {
    shared.width = Math.max(shared.width, cols);
    shared.height = Math.max(shared.height, rows);
  }
  target.colors ??= readColors(canvas);
  const { color, dark } = target.colors;
  const base = Math.floor(nowMs / 1000 / WRAP_S) * WRAP_S;
  const first = params.firstMs === null ? -1 : params.firstMs / 1000 - base;
  const [p0 = -1, p1 = -1, p2 = -1] = params.ports;

  context.viewport(0, 0, cols, rows);
  context.clearColor(0, 0, 0, 0);
  context.clear(context.COLOR_BUFFER_BIT);
  context.uniform2f(at.u_resolution, cols, rows);
  context.uniform1f(at.u_time, nowMs / 1000 - base);
  context.uniform3f(at.u_color, ...color);
  context.uniform3f(at.u_dark, ...dark);
  context.uniform1f(at.u_mode, params.mode === "idle" ? 1 : 0);
  context.uniform1f(at.u_cells, cols);
  context.uniform1f(at.u_period, PERIOD_S);
  context.uniform1f(at.u_link, LINK_S);
  context.uniform1f(at.u_arrive, ARRIVE_S);
  context.uniform1f(at.u_settle, SETTLE_S);
  context.uniform1f(at.u_seed, params.seed);
  context.uniform3f(at.u_ports, p0, p1, p2);
  context.uniform1f(at.u_backing, params.backing ? BACKING : 0);
  context.uniform1f(at.u_phase, params.still ? STILL_PHASE : -1);
  context.uniform1f(at.u_first, first < 0 ? -1 : first);
  context.drawArrays(context.TRIANGLES, 0, 3);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cell = canvas.width / cols;
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = "copy";
  // The shared canvas's rows run bottom up from its lower edge, where the viewport sits.
  ctx.drawImage(shared, 0, shared.height - rows, cols, rows, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "destination-out";
  const gaps = gapPattern(ctx, cell);
  if (gaps) {
    ctx.fillStyle = gaps;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.globalCompositeOperation = "source-over";
  target.drawn = true;
}

/** The 1 px gap on the left and bottom of every cell, as the design draws it, for destination-out. */
function gapPattern(ctx: CanvasRenderingContext2D, cell: number): CanvasPattern | null {
  const size = Math.round(cell);
  const gap = Math.max(1, Math.round((cell * GAP) / CELL));
  const key = `${size}:${gap}`;
  if (patterns.has(key)) return patterns.get(key) ?? null;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d");
  if (t) {
    t.fillStyle = "#000";
    t.fillRect(0, 0, gap, size);
    t.fillRect(0, size - gap, size, gap);
  }
  const pattern = ctx.createPattern(tile, "repeat");
  patterns.set(key, pattern);
  return pattern;
}

/** The theme's accent and surface, resolved on the canvas itself (nodes.css sets both there). */
function readColors(canvas: HTMLCanvasElement): { color: Rgb; dark: Rgb } {
  const style = getComputedStyle(canvas);
  return {
    color: parseColor(style.color, [0.914, 0.89, 0.847]),
    dark: parseColor(style.borderTopColor, [0.055, 0.063, 0.071]),
  };
}

/** "rgb(233, 227, 216)" or "color(srgb 0.91 0.89 0.85)" as 0..1 channels. */
export function parseColor(value: string, fallback: Rgb): Rgb {
  const numbers = value.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  if (numbers.length < 3) return fallback;
  const scale = value.trim().startsWith("color(") ? 1 : 255;
  return [numbers[0]! / scale, numbers[1]! / scale, numbers[2]! / scale];
}

function watch(target: Target) {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      for (const t of targets) if (t.canvas === entry.target) t.visible = entry.isIntersecting;
    }
    schedule();
  });
  observer.observe(target.canvas);
  if (themeWatch) return;
  // A theme change repaints every card with the new accent and surface.
  const repaint = () => {
    for (const t of targets) {
      t.colors = null;
      t.drawn = false;
    }
    schedule();
  };
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", repaint);
  const mutations = new MutationObserver(repaint);
  mutations.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  themeWatch = () => {
    scheme.removeEventListener("change", repaint);
    mutations.disconnect();
  };
}

function stopWatching() {
  themeWatch?.();
  themeWatch = null;
  observer?.disconnect();
  observer = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}
