import {
  type CanvasDetail,
  type CanvasRunCall,
  type CanvasRunInput,
  type CanvasRunPlanItem,
  type CanvasRunState,
  canvasDetailSchema,
  canvasRunStateSchema,
  uploadResponseSchema,
} from "@openfield/core";
import sharp from "sharp";
import type { TestServer } from "./helpers";
import { waitFor } from "./helpers";

// Builders for canvas run plans, shaped like what the browser compiles (§7.7, §8.3).

export const MODEL = "google:gemini-3.1-flash-image" as const;

export async function newCanvas(
  server: TestServer,
  body: Record<string, unknown> = {},
): Promise<CanvasDetail> {
  const res = await server.json("/api/canvases", { method: "POST", body });
  if (res.status !== 201) throw new Error(`Creating a canvas failed: ${JSON.stringify(res.body)}`);
  return canvasDetailSchema.parse(res.body);
}

export function call(overrides: Partial<CanvasRunCall> = {}): CanvasRunCall {
  return {
    model: MODEL,
    op: "generate",
    prompt: "A lighthouse at dusk",
    size: { kind: "aspect", ratio: "3:4" },
    batch: 1,
    seed: null,
    ...overrides,
  };
}

let fingerprints = 0;
/** A distinct, well-formed fingerprint. */
export const fingerprint = (n = ++fingerprints) => `sha256:${n.toString(16).padStart(64, "0")}`;

export function item(nodeId: string, overrides: Partial<CanvasRunPlanItem> = {}): CanvasRunPlanItem {
  return {
    nodeId,
    type: "image.generate",
    typeVersion: 1,
    fingerprint: fingerprint(),
    model: MODEL,
    params: {},
    inputs: [],
    calls: [call()],
    cached: null,
    ...overrides,
  };
}

/** A single image input fed by an earlier plan item: a list here fans out. */
export function fromNode(
  nodeId: string,
  port = "image",
  arity: CanvasRunInput["arity"] = "single",
): CanvasRunInput {
  return {
    port,
    to: "references",
    role: "subject",
    arity,
    values: [{ kind: "node", nodeId, port: "images" }],
  };
}

/** Every canvas_run.updated frame for a run, in order. */
export function runFrames(server: TestServer, runId: string): CanvasRunState[] {
  return server.events
    .filter((e) => e.event === "canvas_run.updated" && (e.data as { runId: string }).runId === runId)
    .map((e) => canvasRunStateSchema.parse(e.data));
}

/** The frame that finished the run. */
export function finished(server: TestServer, runId: string, timeoutMs = 5_000): Promise<CanvasRunState> {
  return waitFor(() => runFrames(server, runId).find((f) => f.finishedAt !== null), timeoutMs);
}

/** A small real image, in any format sharp writes. */
export async function image(
  format: "png" | "jpeg" | "webp" = "png",
  { width = 32, height = 24, background = "#3a6ea5" } = {},
): Promise<Uint8Array> {
  const made = sharp({ create: { width, height, channels: 3, background } });
  return new Uint8Array(await made[format]().toBuffer());
}

/** Distinct images in the library, uploaded the way the Upload node does it. Returns their ids. */
export async function libraryImages(server: TestServer, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const form = new FormData();
    const background = `#${(0x102030 + i * 0x010101).toString(16).padStart(6, "0")}`;
    form.append("file", new File([await image("png", { background })], `ref-${i}.png`));
    const res = await server.request("/api/uploads", { method: "POST", body: form });
    ids.push(uploadResponseSchema.parse(await res.json()).asset.id);
  }
  return ids;
}
