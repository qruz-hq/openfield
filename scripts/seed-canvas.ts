import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { buildEngineContext } from "../packages/canvas/src/engine/context-base.ts";
import { planFingerprints, resolveFingerprints } from "../packages/canvas/src/engine/fingerprint.ts";
import { CARD_WIDTH, cardBox } from "../packages/canvas/src/nodes/generate/card-size.ts";
import { specRegistry } from "../packages/canvas/src/nodes/specs.ts";
import { fromDocument } from "../packages/canvas/src/store/document.ts";
import {
  CANVAS_SCHEMA,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
} from "../packages/core/src/canvas/index.ts";
import { newId, type ProviderSettingsResponse, SESSION_HEADER } from "../packages/core/src/index.ts";

// A big canvas for performance work: about 1,000 nodes shaped like a real project (frames of
// prompts, picked references and Generate cards with results, notes, labels and banners, about 1.1
// links per node), with images of its own. Never your real library: it refuses ~/.openfield unless
// you pass --allow-real-library.
//
//   bun run seed:canvas                          # starts a server on .openfield/dev-canvas, then stops it
//   bun run seed:canvas --home /tmp/x --nodes 1000 --seed 1
//   bun run seed:canvas --port 4431              # a server that's already running
//
// The same seed always gives the same canvas and the same image bytes, so running it again reuses
// the images and replaces the canvas it made before. bun run bench:canvas measures it.

export const SEED_CANVAS_NAME = "Benchmark · large canvas";

/** Shares of each node type, from a real 300-node project canvas. */
const MIX = {
  "image.generate": 0.405,
  "image.asset": 0.361,
  frame: 0.077,
  note: 0.06,
  prompt: 0.047,
  text: 0.037,
  shape: 0.013,
} as const;

/** Aspect ratios of the made images, by how often they appear. */
const ASPECTS = [
  { ratio: "3:4", w: 3, h: 4, weight: 75 },
  { ratio: "16:9", w: 16, h: 9, weight: 12 },
  { ratio: "1:1", w: 1, h: 1, weight: 8 },
  { ratio: "4:5", w: 4, h: 5, weight: 5 },
] as const;
type Aspect = (typeof ASPECTS)[number]["ratio"];

const MODELS = ["google:gemini-3-pro-image", "google:gemini-3.1-flash-image"] as const;
const SUBJECTS = ["ceramic vase", "linen chair", "brass lamp", "glass bottle", "oak stool", "wool throw"];
const SCENES = ["sunlit living room", "studio sweep", "kitchen counter", "garden terrace", "hotel lobby"];

/** A small seeded generator (mulberry32), so a seed always gives the same canvas. */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickOne = <T>(items: readonly T[], r: number): T => items[Math.floor(r * items.length)]!;

/** Splits `total` over `weights` in whole numbers that add up exactly. */
function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * total);
  const out = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0, left = total - out.reduce((a, b) => a + b, 0); k < left; k++) out[order[k]![1]]!++;
  return out;
}

// Images

export interface ImageSpec {
  aspect: Aspect;
  width: number;
  height: number;
  /** Two background colours and three soft blobs, as RGB. */
  colors: [number, number, number][];
  blobs: { x: number; y: number; r: number }[];
}

/** What each made image looks like. Enough variety that no two thumbnails are the same bytes. */
export function planImages(count: number, seed: number): ImageSpec[] {
  const rand = random(seed * 7919 + 17);
  const total = ASPECTS.reduce((a, b) => a + b.weight, 0);
  return Array.from({ length: count }, (_, i) => {
    // Every aspect gets images, the common one most.
    const at = (i / count) * total;
    let aspect: (typeof ASPECTS)[number] = ASPECTS[0];
    for (let below = 0, k = 0; k < ASPECTS.length; k++) {
      below += ASPECTS[k]!.weight;
      if (at < below) {
        aspect = ASPECTS[k]!;
        break;
      }
    }
    const long = 1280;
    const width = aspect.w >= aspect.h ? long : Math.round((long * aspect.w) / aspect.h);
    const height = aspect.w >= aspect.h ? Math.round((long * aspect.h) / aspect.w) : long;
    const color = (): [number, number, number] =>
      [rand() * 255, rand() * 255, rand() * 255].map(Math.round) as [number, number, number];
    return {
      aspect: aspect.ratio,
      width,
      height,
      colors: [color(), color(), color(), color(), color()],
      blobs: Array.from({ length: 3 }, () => ({ x: rand(), y: rand(), r: 0.15 + rand() * 0.3 })),
    };
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A gradient with soft blobs, as an RGB PNG. Smooth, so it stays small. */
export function renderPng(spec: ImageSpec): Uint8Array<ArrayBuffer> {
  const { width, height, colors, blobs } = spec;
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  const [top, bottom, ...tints] = colors;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // no filter
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      let r = top![0] + (bottom![0] - top![0]) * v;
      let g = top![1] + (bottom![1] - top![1]) * v;
      let b = top![2] + (bottom![2] - top![2]) * v;
      blobs.forEach((blob, i) => {
        const d = Math.hypot(u - blob.x, (v - blob.y) * (height / width));
        const k = Math.max(0, 1 - d / blob.r) ** 2;
        const tint = tints[i]!;
        r += (tint[0] - r) * k;
        g += (tint[1] - g) * k;
        b += (tint[2] - b) * k;
      });
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The document

export interface SeedImage {
  id: string;
  aspect: Aspect;
}

export interface CanvasPlanOptions {
  nodes: number;
  seed: number;
  images: readonly SeedImage[];
  name?: string;
}

const GAP = 48;
const PAD = { x: 48, top: 72, bottom: 48 };
const ASSET = 280;
const PROMPT = { w: 544, h: 560 };
const NOTE = { w: 320, h: 280 };

/**
 * The canvas: frames in rows, each with a prompt and a note on the left, then its picked
 * references, then a grid of Generate cards wired to both. Labels sit over some frames and banners
 * over each band of rows. Every Generate with a result shows one of `images` in its own shape.
 */
export function planCanvas(opts: CanvasPlanOptions): CanvasDocument {
  const rand = random(opts.seed);
  const counts = apportion(opts.nodes, Object.values(MIX));
  const [generates, assets, frames, notes, prompts, texts, shapes] = counts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let nextNode = 0;
  let nextEdge = 0;
  const nodeId = () => `n_seed_${(nextNode++).toString(36).padStart(4, "0")}`;
  const link = (source: string, sourceHandle: string, target: string, targetHandle: string, order?: number) =>
    edges.push({
      id: `e_seed_${(nextEdge++).toString(36).padStart(4, "0")}`,
      source,
      sourceHandle,
      target,
      targetHandle,
      ...(order !== undefined && { order }),
      kind: "data",
    });
  const byAspect = new Map<Aspect, SeedImage[]>();
  for (const image of opts.images) byAspect.set(image.aspect, [...(byAspect.get(image.aspect) ?? []), image]);
  const anyImage = () => pickOne(opts.images, rand());
  const base = {
    typeVersion: 1,
    collapsed: false,
    presetLocks: [] as string[],
    result: null,
  };

  // A few big frames and many small ones, like a real project.
  const weights = Array.from({ length: frames }, () => 0.6 + rand() ** 4 * 8);
  const genIn = apportion(generates, weights);
  const assetIn = apportion(assets, weights).map((n, i) => (genIn[i]! > 0 ? Math.max(1, n) : n));
  const promptIn = apportion(
    prompts,
    weights.map(() => rand()),
  );
  const noteIn = apportion(
    notes,
    weights.map(() => rand()),
  );

  const perRow = Math.max(1, Math.round(Math.sqrt(frames) * 1.1));
  const rowsPerBand = Math.max(1, Math.ceil(frames / perRow / Math.max(1, shapes)));
  let y = 0;
  let textsLeft = texts;
  let shapesLeft = shapes;
  for (let row = 0; row * perRow < frames; row++) {
    // A banner over each band of rows, as wide as its first row.
    let banner: CanvasNode | null = null;
    if (row % rowsPerBand === 0 && shapesLeft > 0) {
      shapesLeft--;
      banner = {
        ...base,
        id: nodeId(),
        type: "shape",
        position: { x: 0, y },
        size: { w: 1, h: 400 },
        parentId: null,
        title: `Banner ${row / rowsPerBand + 1}`,
        params: { shape: "rectangle", text: `Section ${row / rowsPerBand + 1} · ${pickOne(SCENES, rand())}` },
      };
      nodes.push(banner);
      y += 400 + 240;
    }
    let x = 0;
    let rowHeight = 0;
    for (let col = 0; col < perRow; col++) {
      const f = row * perRow + col;
      if (f >= frames) break;
      const frameId = nodeId();
      const frame: CanvasNode = {
        ...base,
        id: frameId,
        type: "frame",
        position: { x, y },
        size: { w: 1, h: 1 },
        parentId: null,
        title: `${String(f + 1).padStart(2, "0")} · ${pickOne(SUBJECTS, rand())} in a ${pickOne(SCENES, rand())}`,
        params: {},
      };
      nodes.push(frame);
      if (textsLeft > 0 && rand() < texts / frames + 0.1) {
        textsLeft--;
        nodes.push({
          ...base,
          id: nodeId(),
          type: "text",
          position: { x, y: y - 120 },
          parentId: null,
          title: null,
          params: { text: `Round ${f + 1}: ${pickOne(SUBJECTS, rand())}, ${pickOne(SCENES, rand())}` },
        });
      }

      // Left column: the brief and a note.
      let left = 0;
      let at = PAD.top;
      let promptId: string | null = null;
      for (let p = 0; p < promptIn[f]!; p++) {
        promptId = nodeId();
        nodes.push({
          ...base,
          id: promptId,
          type: "prompt",
          position: { x: PAD.x, y: at },
          size: { ...PROMPT },
          parentId: frameId,
          title: `Brief ${f + 1}`,
          params: {
            text: `PRODUCT: a ${pickOne(SUBJECTS, rand())}. SCENE: ${pickOne(SCENES, rand())}, soft daylight, shot at eye height. Keep the product true to its size and colour.`,
          },
        });
        at += PROMPT.h + GAP;
        left = Math.max(left, PROMPT.w);
      }
      for (let n = 0; n < noteIn[f]!; n++) {
        nodes.push({
          ...base,
          id: nodeId(),
          type: "note",
          position: { x: PAD.x, y: at },
          size: { ...NOTE },
          parentId: frameId,
          title: "Notes",
          params: {
            text: "Swap the product here, then rerun the frame.\nKeep the light consistent.",
            tint: 0,
          },
        });
        at += NOTE.h + GAP;
        left = Math.max(left, NOTE.w);
      }
      let bottom = at;

      // References in two columns.
      const refX = PAD.x + (left ? left + GAP : 0);
      const refs: string[] = [];
      for (let a = 0; a < assetIn[f]!; a++) {
        const id = nodeId();
        const roll = rand();
        const many = roll < 0.77 ? 1 : roll < 0.87 ? 2 : roll < 0.99 ? 3 + Math.floor(rand() * 2) : 6;
        nodes.push({
          ...base,
          id,
          type: "image.asset",
          position: { x: refX + (a % 2) * (ASSET + 32), y: PAD.top + Math.floor(a / 2) * (ASSET + 32) },
          size: { w: ASSET, h: ASSET },
          parentId: frameId,
          title: `Reference ${a + 1}`,
          params: { assetIds: Array.from({ length: many }, () => anyImage().id) },
        });
        refs.push(id);
      }
      const refCols = Math.min(2, refs.length);
      bottom = Math.max(bottom, PAD.top + Math.ceil(refs.length / 2) * (ASSET + 32));

      // Generate cards, four to a row, each wired to the brief and some references.
      const genX = refX + (refCols ? refCols * (ASSET + 32) + GAP : 0);
      const made: string[] = [];
      let genRight = genX;
      let rowTop = PAD.top;
      let rowTall = 0;
      for (let g = 0; g < genIn[f]!; g++) {
        if (g > 0 && g % 4 === 0) {
          rowTop += rowTall + GAP;
          rowTall = 0;
        }
        const aspect = rand() < 0.85 ? "3:4" : pickOne(ASPECTS, rand()).ratio;
        const [w, h] = aspect.split(":").map(Number) as [number, number];
        const box = cardBox(w / h);
        const size = { w: Math.round(box.w * 100) / 100, h: Math.round(box.h * 100) / 100 };
        const gx = genX + (g % 4) * (CARD_WIDTH + 32);
        const id = nodeId();
        const ran = rand() < 0.91;
        const pool = byAspect.get(aspect) ?? opts.images;
        const outputs = ran
          ? Array.from({ length: rand() < 0.03 ? 2 : 1 }, () => pickOne(pool, rand()).id)
          : [];
        const model = pickOne(MODELS, rand());
        nodes.push({
          ...base,
          id,
          type: "image.generate",
          position: { x: gx, y: rowTop },
          size,
          parentId: frameId,
          title: `Take ${g + 1}`,
          params: {
            model,
            prompt: `The ${pickOne(SUBJECTS, rand())} turned about ${10 + Math.floor(rand() * 60)} degrees, camera slightly above.`,
            batch: 1,
            seed: { mode: "random" },
            enhancePrompt: false,
            providerOptions: {},
            resolution: "1K",
            size: { kind: "aspect", ratio: aspect },
          },
          result: ran
            ? {
                state: "done",
                assetIds: outputs,
                jobSetId: null,
                jobSetIds: [],
                outputs: outputs.map((assetId) => ({ assetId, model, call: 0, source: 0 })),
                fingerprint: null,
                costUsd: null,
                ranAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
                error: null,
              }
            : null,
        });
        if (promptId) link(promptId, "text", id, "prompt");
        const wanted = refs.length ? 1 + Math.floor(rand() * Math.min(3, refs.length)) : 0;
        const from = [...refs].sort(() => rand() - 0.5).slice(0, wanted);
        // Now and then a take builds on an earlier one.
        if (made.length && rand() < 0.25) from.push(pickOne(made, rand()));
        for (const [order, source] of from.entries()) link(source, "images", id, "input_images", order);
        made.push(id);
        rowTall = Math.max(rowTall, size.h);
        genRight = Math.max(genRight, gx + size.w);
      }
      if (made.length) bottom = Math.max(bottom, rowTop + rowTall);
      frame.size = {
        w: Math.max(640, Math.max(genRight, refX + refCols * (ASSET + 32), PAD.x + left) + PAD.x),
        h: bottom + PAD.bottom,
      };
      x += frame.size.w + 200;
      rowHeight = Math.max(rowHeight, frame.size.h);
    }
    if (banner) banner.size = { w: x - 200, h: 400 };
    y += rowHeight + 320;
  }
  // Banners and labels left over float under the last row, like an archive band.
  for (; shapesLeft > 0; shapesLeft--) {
    nodes.push({
      ...base,
      id: nodeId(),
      type: "shape",
      position: { x: (shapesLeft - 1) * 3200, y },
      size: { w: 2800, h: 400 },
      parentId: null,
      title: "Archive",
      params: { shape: "rectangle", text: "Archive: reference only" },
    });
  }
  y += 640;
  for (; textsLeft > 0; textsLeft--) {
    nodes.push({
      ...base,
      id: nodeId(),
      type: "text",
      position: { x: textsLeft * 900, y },
      parentId: null,
      title: null,
      params: { text: "Archive: reference only" },
    });
  }

  const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
  return {
    schema: CANVAS_SCHEMA,
    id: newId(),
    name: opts.name ?? SEED_CANVAS_NAME,
    createdAt: at,
    updatedAt: at,
    // Opens on the first frame at 100%, where people work.
    viewport: { x: 80, y: 80, zoom: 1 },
    nodes,
    edges,
    comments: [],
    meta: {},
  };
}

// Talking to Openfield

interface Server {
  origin: string;
  token: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? done(address.port) : fail(new Error("no port")),
      );
    });
  });
}

async function sessionToken(origin: string): Promise<string> {
  const html = await (await fetch(`${origin}/`)).text();
  const token = /<meta name="openfield-session" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error(`${origin} doesn't look like Openfield`);
  return token;
}

/** A server of its own on `home`, with fake models so nothing can cost money. */
async function startServer(home: string): Promise<Server> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      OPENFIELD_HOME: home,
      OPENFIELD_PORT: String(port),
      OPENFIELD_FAKE_PROVIDERS: "1",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let tries = 0; ; tries++) {
    try {
      const token = await sessionToken(origin);
      return {
        origin,
        token,
        stop: async () => {
          proc.kill("SIGTERM");
          await proc.exited;
        },
      };
    } catch (error) {
      if (tries > 150 || proc.exitCode !== null) {
        proc.kill();
        throw error;
      }
      await Bun.sleep(100);
    }
  }
}

async function call<T>(server: Server, method: string, path: string, body?: unknown): Promise<T> {
  const json = body !== undefined && !(body instanceof FormData);
  const res = await fetch(`${server.origin}${path}`, {
    method,
    headers: { [SESSION_HEADER]: server.token, ...(json && { "content-type": "application/json" }) },
    body: json ? JSON.stringify(body) : (body as FormData | undefined),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Stamps each result with the fingerprint the editor works out for it, from the server's own models
 * and settings, so the cards open up to date as they would after a real run.
 */
async function upToDate(server: Server, doc: CanvasDocument): Promise<CanvasDocument> {
  const [{ models }, settings, providers] = await Promise.all([
    call<{ models: Parameters<typeof buildEngineContext>[0] }>(server, "GET", "/api/models?modality=all"),
    call<Parameters<typeof buildEngineContext>[1]>(server, "GET", "/api/settings"),
    call<NonNullable<Parameters<typeof buildEngineContext>[2]>>(server, "GET", "/api/providers"),
  ]);
  const speeds = new Map(
    await Promise.all(
      providers.map(
        async (p) =>
          [
            p.id,
            await call<ProviderSettingsResponse>(server, "GET", `/api/providers/${p.id}/settings`),
          ] as const,
      ),
    ),
  );
  const ctx = buildEngineContext(models, settings, providers, speeds);
  const fingerprints = await resolveFingerprints(
    planFingerprints(fromDocument(doc).slice, specRegistry, ctx),
    new Map(),
  );
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.result
        ? { ...node, result: { ...node.result, fingerprint: fingerprints[node.id] ?? null } }
        : node,
    ),
  };
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        await work(items[i]!, i);
      }
    }),
  );
}

function resolveHome(raw: string): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

const THUMB_SIZES = [200, 280, 360, 456, 640].flatMap((h) => [`h=${h}`, `h=${h}&dpr=2`]);

async function main() {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      port: { type: "string" },
      nodes: { type: "string", default: "1000" },
      images: { type: "string", default: "300" },
      seed: { type: "string", default: "1" },
      name: { type: "string", default: SEED_CANVAS_NAME },
      "allow-real-library": { type: "boolean", default: false },
      "no-warm": { type: "boolean", default: false },
    },
  });
  const real = join(homedir(), ".openfield");
  let server: Server;
  if (values.port) {
    const origin = `http://127.0.0.1:${values.port}`;
    server = { origin, token: await sessionToken(origin), stop: async () => {} };
  } else {
    const home = resolveHome(
      values.home ?? process.env.OPENFIELD_HOME ?? join(import.meta.dir, "..", ".openfield", "dev-canvas"),
    );
    if (home === real && !values["allow-real-library"]) {
      console.error("That's your real library. Pick another folder with --home.");
      process.exit(1);
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    server = await startServer(home);
    // Its models are fake, so any key works: the cards look as they do with a key set.
    await call(server, "PUT", "/api/settings/keys/google", {
      apiKey: "AIzaFakeKeyForTheCanvasSeed000000000",
    });
  }

  try {
    const { home } = await call<{ home: string }>(server, "GET", "/api/health");
    if (resolve(home) === real && !values["allow-real-library"]) {
      console.error(`The server on ${server.origin} uses your real library. Point it at another one.`);
      process.exit(1);
    }
    const seed = Number(values.seed);
    const specs = planImages(Number(values.images), seed);
    const images: SeedImage[] = new Array(specs.length);
    await pool(specs, 6, async (spec, i) => {
      const form = new FormData();
      form.append("file", new File([renderPng(spec)], `seed-${seed}-${i}.png`, { type: "image/png" }));
      const { asset } = await call<{ asset: { id: string } }>(server, "POST", "/api/uploads", form);
      images[i] = { id: asset.id, aspect: spec.aspect };
    });
    console.log(`${images.length} images in ${home}.`);

    const doc = await upToDate(
      server,
      planCanvas({ nodes: Number(values.nodes), seed, images, name: values.name }),
    );
    const earlier = await call<{ id: string; name: string }[]>(
      server,
      "GET",
      `/api/canvases?q=${encodeURIComponent(values.name)}`,
    );
    for (const old of earlier.filter((c) => c.name === values.name)) {
      await call(server, "DELETE", `/api/canvases/${old.id}`);
    }
    const made = await call<{ id: string }>(server, "POST", "/api/canvases", {
      name: values.name,
      graph: doc,
    });
    console.log(`${doc.nodes.length} nodes and ${doc.edges.length} links in "${values.name}".`);

    // Thumbnails are made on first ask: make them now so a benchmark's first open isn't timing that.
    if (!values["no-warm"]) {
      const asks = images.flatMap((image) => THUMB_SIZES.map((q) => `/files/thumb/${image.id}?${q}`));
      await pool(asks, 8, async (path) => {
        const res = await fetch(`${server.origin}${path}`, { headers: { [SESSION_HEADER]: server.token } });
        await res.arrayBuffer();
      });
      console.log(`Made ${asks.length} thumbnails.`);
    }
    console.log(`Canvas ${made.id}`);
    if (values.port) console.log(`Open ${server.origin}/canvas/${made.id}`);
  } finally {
    await server.stop();
  }
}

if (import.meta.main) await main();
