import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import {
  type DocSlice,
  evaluateGraph,
  fromDocument,
  nodeTitle,
  planFingerprints,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import type { CanvasOp } from "@openfield/canvas/store/ops";
import {
  type AgentActor,
  type CanvasRunState,
  type ErrorCode,
  errorCopy,
  isTerminalState,
} from "@openfield/core";
import type { CanvasDocument, CanvasNode, CanvasNodeResult } from "@openfield/core/canvas";
import { getAssets, getCanvas, getJobSet, listCanvases } from "@openfield/db";
import { blockerMessage } from "../canvas/blockers";
import { readDocument } from "../canvas/documents";
import { serverEngineContext } from "../canvas/engine-context";
import { providerSummaries } from "../services/provider-summaries";
import { describeImages, type ImageInfo } from "./images";
import { type Extra, Refusal, type ToolContext } from "./kit";

// Canvases as agents see them: which one they mean, what's on it in a form small enough to read,
// and runs. Tools that change a canvas go through the canvas service with the agent as the actor,
// so every open tab replays the change live and names the agent (§7.11).

export const ACTIVE = "active";

/** Opens a canvas in the app. */
export const canvasUrl = (ctx: ToolContext, id: string) => `http://127.0.0.1:${ctx.svc.port}/canvas/${id}`;

export function actorOf(ctx: ToolContext): AgentActor {
  return { kind: "agent", name: ctx.session.client, sessionId: ctx.session.id ?? ctx.session.client };
}

/**
 * The canvas an agent names: its id, its exact name when only one has it, or "active" for the one
 * open in the tab the person used last.
 */
export function resolveCanvas(ctx: ToolContext, ref: string): { id: string; name: string } {
  const value = ref.trim();
  if (value.toLowerCase() === ACTIVE) {
    const tab = ctx.svc.presence.active();
    if (!tab) {
      throw new Refusal(
        "No Openfield tab is open, so there's no active canvas. Pass a canvas id from list_canvases.",
      );
    }
    if (!tab.canvasId) {
      throw new Refusal(
        `The Openfield tab the person used last isn't showing a canvas (it's on ${tab.path}). Pass a canvas id from list_canvases, or open one with show.`,
      );
    }
    return byId(ctx, tab.canvasId) ?? missing(value);
  }
  const found = byId(ctx, value);
  if (found) return found;
  const named = listCanvases(ctx.svc.db).filter((c) => c.name.toLowerCase() === value.toLowerCase());
  if (named.length === 1) return { id: named[0]!.id, name: named[0]!.name };
  if (named.length > 1) {
    throw new Refusal(
      `${named.length} canvases are called "${value}". Pass the id of the one you mean: ${named.map((c) => c.id).join(", ")}.`,
    );
  }
  return missing(value);
}

function byId(ctx: ToolContext, id: string) {
  const row = getCanvas(ctx.svc.db, id);
  return row ? { id: row.id, name: row.name } : undefined;
}

const missing = (value: string): never => {
  throw new Refusal(`There's no canvas "${value}". Call list_canvases to see them.`);
};

export const canvasField = `A canvas id from list_canvases, its exact name, or "${ACTIVE}" for the canvas open in Openfield right now.`;

/** Keeps a working agent's pill up in open tabs while it reads, without raising one. */
export function reading(ctx: ToolContext, canvasId: string, nodeIds: string[] = []): void {
  ctx.svc.events.publish("agent.activity", {
    canvasId,
    actor: actorOf(ctx),
    nodeIds,
    kind: "reading",
    at: new Date().toISOString(),
  });
}

// What's on a canvas

/** The settings worth showing per node type; everything else stays out to keep answers small. */
const SHOWN_PARAMS: Partial<Record<string, readonly string[]>> = {
  prompt: ["text"],
  "image.upload": ["assetIds"],
  "image.asset": ["assetIds"],
  "image.generate": ["model", "prompt", "size", "resolution", "quality", "batch", "seed"],
  "image.variations": ["strategy", "count", "model", "models", "prompts", "size", "resolution", "quality"],
  note: ["text"],
  text: ["text"],
  shape: ["shape", "text"],
};

export type NodeState = "idle" | "running" | "done" | "stale" | "failed" | "canceled";

export interface NodeView {
  id: string;
  type: string;
  title: string;
  position: { x: number; y: number };
  parentId?: string;
  params: Record<string, unknown>;
  /** Nodes that make images. */
  state?: NodeState;
  /** Why it can't run now, in the words on the node. */
  needs?: string;
  images?: string[];
  error?: string;
  costUsd?: number | null;
}

export interface CanvasView {
  canvasId: string;
  name: string;
  graphVersion: number;
  updatedAt: string;
  url: string;
  /** Tabs showing it now: the person sees changes to it as they happen. */
  openInTabs: number;
  nodes: NodeView[];
  edges: { id: string; from: string; to: string; kind?: "annotation" }[];
}

export async function describeCanvas(
  ctx: ToolContext,
  canvasId: string,
): Promise<{ view: CanvasView; doc: CanvasDocument }> {
  const row = getCanvas(ctx.svc.db, canvasId);
  if (!row) return missing(canvasId);
  const doc = readDocument(row.graph);
  const { slice } = fromDocument(doc);
  const named = doc.nodes.flatMap((n) => n.result?.assetIds ?? []);
  const here = new Set(getAssets(ctx.svc.db, named).map((a) => a.id));
  const engine = { ...serverEngineContext(ctx.svc), missing: new Set(named.filter((id) => !here.has(id))) };
  const fingerprints = await resolveFingerprints(planFingerprints(slice, specRegistry, engine), new Map());
  // As if everything ran, so each node's blockers and inputs are worked out as a Run all would.
  const evaluation = evaluateGraph({
    doc: slice,
    registry: specRegistry,
    ctx: engine,
    fingerprints,
    runs: () => true,
  });
  const busy = ctx.svc.canvasRuns.busyNodes(canvasId);
  const providers = providerSummaries(ctx.svc);

  const nodes = doc.nodes.map((node): NodeView => {
    const spec = specRegistry.get(node.type);
    const ev = evaluation.nodes.get(node.id);
    const view: NodeView = {
      id: node.id,
      type: node.type,
      title: nodeTitle(node, specRegistry),
      position: node.position,
      ...(node.parentId && { parentId: node.parentId }),
      params: pick(node.params, SHOWN_PARAMS[node.type]),
    };
    if (!spec?.runnable) return view;
    // Done, as the node shows it: made with its current settings from what it reads now.
    const current = node.result?.fingerprint === fingerprints[node.id] && !ev?.inputsChanged;
    view.state = busy.has(node.id) ? "running" : stateOf(node.result, current);
    if (ev?.blocker && view.state !== "running") view.needs = blockerMessage(ev.blocker, providers);
    const images = node.result?.assetIds ?? [];
    if (images.length) view.images = [...images];
    const error = errorText(node.result?.error ?? null);
    if (error && (view.state === "failed" || view.state === "canceled")) view.error = error;
    if (node.result?.costUsd !== undefined && node.result.costUsd !== null)
      view.costUsd = node.result.costUsd;
    return view;
  });
  const edges = doc.edges.map((e) => ({
    id: e.id,
    from: `${e.source}.${e.sourceHandle}`,
    to: `${e.target}.${e.targetHandle}`,
    ...(e.kind === "annotation" && { kind: "annotation" as const }),
  }));
  return {
    doc,
    view: {
      canvasId,
      name: row.name,
      graphVersion: row.graphVersion,
      updatedAt: row.updatedAt,
      url: canvasUrl(ctx, canvasId),
      openInTabs: ctx.svc.presence.tabsOn(canvasId).length,
      nodes,
      edges,
    },
  };
}

function stateOf(result: CanvasNodeResult | null, current: boolean): NodeState {
  if (!result) return "idle";
  if (result.state === "failed" || result.state === "canceled") return current ? result.state : "idle";
  if (!result.assetIds.length) return "idle";
  return current ? "done" : "stale";
}

function pick(params: Record<string, unknown>, keys: readonly string[] | undefined): Record<string, unknown> {
  if (!keys) return {};
  return Object.fromEntries(keys.filter((k) => params[k] !== undefined).map((k) => [k, params[k]]));
}

function errorText(error: { code: string; reason?: string | undefined } | null): string | undefined {
  if (!error) return undefined;
  if (error.reason) return error.reason;
  try {
    return errorCopy(error.code as ErrorCode).reason;
  } catch {
    return error.code;
  }
}

/** Previews of the first images on a canvas, for get_canvas and the canvas resource. */
export async function canvasPreviews(
  ctx: ToolContext,
  view: CanvasView,
  max: number,
): Promise<ImageContent[]> {
  const ids = view.nodes.flatMap((n) => n.images ?? []).slice(0, max);
  const rows = getAssets(ctx.svc.db, ids);
  return (await describeImages(ctx, rows, { previews: true })).blocks;
}

// Runs

export interface CanvasRunView {
  canvasId: string;
  runId: string;
  status: string;
  finished: boolean;
  spentUsd: number;
  nodes: {
    nodeId: string;
    title: string;
    state: string;
    done: number;
    total: number;
    images: ImageInfo[];
    error?: string;
    costUsd: number | null;
  }[];
  next?: string;
}

export async function describeCanvasRun(
  ctx: ToolContext,
  state: CanvasRunState,
  opts: { previews: boolean; maxPreviews?: number },
): Promise<{ view: CanvasRunView; blocks: ImageContent[] }> {
  const row = getCanvas(ctx.svc.db, state.canvasId);
  const doc = row ? readDocument(row.graph) : null;
  const title = (nodeId: string) => {
    const node = doc?.nodes.find((n) => n.id === nodeId);
    return node ? nodeTitle(node, specRegistry) : nodeId;
  };
  const blocks: ImageContent[] = [];
  let previews = opts.maxPreviews ?? 8;
  const nodes: CanvasRunView["nodes"] = [];
  for (const node of state.nodes) {
    const described = await describeImages(ctx, getAssets(ctx.svc.db, node.assetIds), {
      previews: opts.previews && previews > 0,
      max: previews,
    });
    previews -= described.blocks.length;
    blocks.push(...described.blocks);
    const error = errorText(node.error);
    nodes.push({
      nodeId: node.nodeId,
      title: title(node.nodeId),
      state: node.state,
      done: node.done,
      total: node.total,
      images: described.images,
      ...(error && { error }),
      costUsd: node.costUsd,
    });
  }
  const finished = isTerminalState(state.status);
  const view: CanvasRunView = {
    canvasId: state.canvasId,
    runId: state.runId,
    status: state.status,
    finished,
    spentUsd: Math.round(nodes.reduce((sum, n) => sum + (n.costUsd ?? 0), 0) * 1e6) / 1e6,
    nodes,
  };
  if (!finished) view.next = "Still running. Call get_run with this runId and a wait to get the images.";
  return { view, blocks };
}

/** Waits until a canvas run ends, the time is up, or the app gives up. True when it ended. */
export function waitForCanvasRun(
  ctx: ToolContext,
  canvasId: string,
  runId: string,
  seconds: number,
  extra: Extra,
): Promise<boolean> {
  const current = () => ctx.svc.canvasRuns.state(canvasId, runId);
  const ended = () => {
    const state = current();
    return !state || isTerminalState(state.status);
  };
  if (ended()) return Promise.resolve(true);
  if (seconds <= 0 || atBatchSpeed(ctx, current())) return Promise.resolve(false);
  const token = extra._meta?.progressToken;
  let reported = -1;
  const report = (state: CanvasRunState | undefined) => {
    if (token === undefined || !state) return;
    const total = state.nodes.reduce((n, node) => n + node.total, 0);
    const done = state.nodes.reduce((n, node) => n + node.done, 0);
    if (done <= reported) return;
    reported = done;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: done, total, message: `${done} of ${total} images done` },
      })
      .catch(() => {});
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(poll);
      clearTimeout(timer);
      extra.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const check = () => {
      report(current());
      if (ended()) finish(true);
    };
    const unsubscribe = ctx.svc.events.subscribe((event, data) => {
      if (event === "canvas_run.updated" && (data as CanvasRunState).runId === runId) check();
    });
    const poll = setInterval(check, 1_000);
    const timer = setTimeout(() => finish(ended()), seconds * 1000);
    const onAbort = () => finish(ended());
    extra.signal.addEventListener("abort", onAbort);
    check();
  });
}

/** A run whose images wait at the company's Batch speed takes hours: it's handed back at once. */
function atBatchSpeed(ctx: ToolContext, state: CanvasRunState | undefined): boolean {
  return !!state?.nodes.some((n) => n.jobSetIds.some((id) => getJobSet(ctx.svc.db, id)?.speed === "batch"));
}

// Versions

/**
 * The document ops that turn a canvas into a saved version of it: every node out (the ones inside
 * frames first), then the version's nodes (frames first) and connections. Sent like any edit, so
 * open tabs show the restore as it happens.
 */
export function restoreOps(current: DocSlice, version: CanvasDocument): CanvasOp[] {
  const depth = (nodes: Readonly<Record<string, { parentId: string | null }>>, id: string) => {
    let d = 0;
    for (let at = nodes[id]?.parentId ?? null; at && d < 64; at = nodes[at]?.parentId ?? null) d++;
    return d;
  };
  const removals = [...current.order]
    .sort((a, b) => depth(current.nodes, b) - depth(current.nodes, a))
    .map((id): CanvasOp => ({ op: "deleteNode", id }));
  const byId = Object.fromEntries(version.nodes.map((n) => [n.id, n]));
  const additions = [...version.nodes]
    .sort((a, b) => depth(byId, a.id) - depth(byId, b.id))
    .map((node: CanvasNode): CanvasOp => ({ op: "addNode", node: structuredClone(node) }));
  const edges = version.edges.map((edge): CanvasOp => ({ op: "addEdge", edge: { ...edge } }));
  return [...removals, ...additions, ...edges];
}
