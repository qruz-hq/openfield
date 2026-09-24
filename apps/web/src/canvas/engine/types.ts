import type {
  AspectRatio,
  CANVAS_PORT_TYPES,
  CanvasBlockReason,
  CanvasNodeState,
  CanvasNodeType,
  CanvasRunNodeResult,
  CanvasRunNodeState,
  CanvasRunScope,
  CanvasRunState,
  CostEstimate,
  ErrorCode,
  MessageKey,
  ModelKey,
  ModelListItem,
  ReferenceRole,
  ResolutionTier,
  SizeSpec,
} from "@openfield/core";
import type { CanvasNodeResult } from "@openfield/core/canvas";
import type { RunSpeed } from "../../lib/provider-settings";

// Shared engine vocabulary (§7.6, §7.7, §0.11). Pure types plus a few constant tables: no React,
// no store, no fetch, so the compiler, fingerprints and their tests stay plain functions.

// Ports

export type PortType = (typeof CANVAS_PORT_TYPES)[number];
export type PortDirection = "in" | "out";
/** single: one edge, a second one replaces it. multi: N edges, kept in connection order. */
export type PortArity = "single" | "multi";
/** How many values an output hands on. A list into a single input fans out (§7.7). */
export type PortItems = "one" | "list";

/** Where an input's images go in each request the node makes. Text is resolved into the prompt. */
export type PortBinding =
  | { to: "prompt" }
  | { to: "references"; role: ReferenceRole }
  | { to: "base" }
  | { to: "mask" };

export interface PortSpec {
  /** The React Flow handle id, stored on edges as sourceHandle / targetHandle. Never rename. */
  id: string;
  /** The port's name in its tooltip ("Reference images"). */
  label?: MessageKey;
  direction: PortDirection;
  type: PortType;
  /** Inputs only. Outputs always accept any number of edges. */
  arity: PortArity;
  /** Outputs only. */
  items: PortItems;
  /** Must be connected (or filled inline) before the node can run. */
  required: boolean;
  /** Inputs only: how the run plan uses the values. */
  binding?: PortBinding;
  /**
   * Hidden until the feature behind it ships (the style input waits for the Style node, M4-20).
   * A hidden port isn't drawn, takes no connections and doesn't count for the rail layout.
   */
  hidden?: boolean;
}

/** Compatibility (§7.6). "coerce" is image into mask: luminance becomes alpha, white is the edit area. */
export type PortFlow = "ok" | "coerce" | "no";

export const PORT_COMPATIBILITY: Readonly<Record<PortType, Readonly<Record<PortType, PortFlow>>>> = {
  text: { text: "ok", image: "no", mask: "no", preset: "no", video: "no", audio: "no" },
  image: { text: "no", image: "ok", mask: "coerce", preset: "no", video: "no", audio: "no" },
  mask: { text: "no", image: "ok", mask: "ok", preset: "no", video: "no", audio: "no" },
  preset: { text: "no", image: "no", mask: "no", preset: "ok", video: "no", audio: "no" },
  video: { text: "no", image: "no", mask: "no", preset: "no", video: "ok", audio: "no" },
  audio: { text: "no", image: "no", mask: "no", preset: "no", video: "no", audio: "ok" },
};

export const portFlow = (from: PortType, to: PortType): PortFlow => PORT_COMPATIBILITY[from][to];

/** Every node also has these four pairs, for annotation arrows only. They never carry data. */
export const ANNOTATION_SIDES = ["top", "right", "bottom", "left"] as const;
export type AnnotationSide = (typeof ANNOTATION_SIDES)[number];
export const annotationSourceHandle = (side: AnnotationSide) => `arrow-source-${side}` as const;
export const annotationTargetHandle = (side: AnnotationSide) => `arrow-target-${side}` as const;
export const isAnnotationHandle = (handleId: string | null | undefined): boolean =>
  !!handleId && /^arrow-(source|target)-(top|right|bottom|left)$/.test(handleId);

/** Port rails: centres 36 apart, spread around the node's vertical middle (Canvas kit pUPWt). */
export const PORT_SPACING = 36;

// Context every pure engine function receives

export interface EngineContext {
  /** Enabled models with their manifests, from GET /api/models. */
  models: readonly ModelListItem[];
  model(key: string | null | undefined): ModelListItem | undefined;
  /** settings.defaultModel, else the first model with a key. */
  defaultModel: ModelKey | null;
  /** settings.defaultBatch: how many images a new Generate node makes. */
  defaultBatch?: number;
  /** settings.defaultAspect: written into a new node. A node without a size uses the model's default. */
  defaultAspect?: AspectRatio | null;
  /** True when the person turned this company off in Settings (its models are hidden then). */
  companyOff?(providerId: string): boolean;
  /** Images the canvas names that aren't in this library: drawn as placeholders, never sent. */
  missing?: ReadonlySet<string>;
  /** The speed a run of this model gets from its company's settings (§0.3). Standard when absent. */
  runSpeed?(model: ModelListItem): RunSpeed;
}

/** A node as the engine sees it: document fields only, params already parsed by its type. */
export interface EngineNode<P = Record<string, unknown>> {
  id: string;
  type: CanvasNodeType;
  typeVersion: number;
  title: string | null;
  params: P;
  result: CanvasNodeResult | null;
}

// Values on edges at plan time

export type PortValue =
  | { kind: "text"; text: string }
  /** `prompt`: the text that made it, when a node here made it (Variations reuses it). */
  | { kind: "asset"; assetId: string; model?: ModelKey | null; prompt?: string }
  /** A runnable node in the same run. Its images arrive later; `expected` is for fan-out and cost. */
  | { kind: "pending"; nodeId: string; port: string; expected: number; prompt?: string };

/** By input port id, values in edge order. */
export type ResolvedInputs = Readonly<Record<string, readonly PortValue[]>>;
/** By output port id. */
export type OutputValues = Readonly<Record<string, readonly PortValue[]>>;

/** Prompt parts (upstream text, then the node's own) join with a new line. */
export const PROMPT_JOINER = "\n";

// Blockers (the hatched band, §7.5). Copy lives with the nodes, keyed by kind.

export type NodeBlocker =
  | { kind: "no_key"; model: ModelKey }
  | { kind: "model_unavailable"; model: ModelKey | null }
  | { kind: "company_off"; model: ModelKey }
  | { kind: "missing_input"; port: string }
  | { kind: "no_prompt" }
  | { kind: "references_unsupported"; model: ModelKey }
  | { kind: "too_many_references"; model: ModelKey; max: number }
  /** Variations in Prompts or Models mode needs at least `min` entries. */
  | { kind: "needs_more"; what: "prompts" | "models"; min: number }
  /** A fan-out that would make more images than a run can (CANVAS_RUN_MAX_JOBS). */
  | { kind: "too_many_jobs"; max: number }
  /** An image it reads isn't in this library. */
  | { kind: "missing_asset" }
  | { kind: "upstream_failed"; nodeId: string }
  | { kind: "upstream_blocked"; nodeId: string }
  /** In a loop, or below one. Only an imported file can make one; connecting never does. */
  | { kind: "loop" };

// Fingerprints (§0.11, M4-16)

/**
 * What one node's fingerprint hashes, with hashCanonical() from @openfield/core:
 * typeId, typeVersion, normalized params, model key, manifest version and the upstream
 * fingerprints in port order. Annotation nodes have none.
 */
export interface FingerprintInput {
  typeId: CanvasNodeType;
  typeVersion: number;
  params: unknown;
  modelKey: ModelKey | null;
  manifestVersion: string | null;
  /** [inputPortId, upstream fingerprints in edge order], in the type's port order. */
  upstream: readonly (readonly [string, readonly string[]])[];
}

export interface FingerprintParams {
  /** Only what changes the images: resolved against the model's defaults, no UI-only fields. */
  params: unknown;
  model: ModelKey | null;
  manifestVersion: string | null;
  /** False when every run should give a new result anyway: seed "random" on a model with seeds. */
  cacheable: boolean;
}

// Compiling one node for the run plan (§7.7)

/** One request template: a GenerateRequest minus what the server fills in per job set. */
export interface RunCall {
  model: ModelKey;
  op: "generate" | "variation" | "edit" | "inpaint";
  prompt: string;
  negativePrompt?: string;
  enhancePrompt?: boolean;
  size: SizeSpec;
  resolution?: ResolutionTier;
  quality?: string;
  batch: number;
  /** null: the server picks seeds, only on models that take them (§0.11). */
  seed: number | null;
  providerOptions?: Record<string, unknown>;
  /** Caption for this call's images in the result grid, e.g. the prompt line. */
  label?: string;
}

/** One image input of a plan item, bound into every request the node makes. */
export interface RunInput {
  port: string;
  to: "references" | "base" | "mask";
  role?: ReferenceRole;
  arity: PortArity;
  values: ({ kind: "asset"; assetId: string } | { kind: "node"; nodeId: string; port: string })[];
}

/**
 * One entry of the plan the browser POSTs to /api/canvases/:id/run (§8.3). Arrays are mutable on
 * purpose: the typed client's body type is zod's input type, which a readonly array can't fill.
 */
export interface RunPlanItem {
  nodeId: string;
  type: CanvasNodeType;
  typeVersion: number;
  fingerprint: string;
  model: ModelKey;
  params: Record<string, unknown>;
  inputs: RunInput[];
  calls: RunCall[];
  /** The node's current result, so the server can skip it when nothing changed and its images still exist. */
  cached: { fingerprint: string; assetIds: string[] } | null;
  /** ⌥-click: run even when cached. */
  bypassCache?: boolean;
}

export interface CompiledNode {
  item: RunPlanItem;
  /** Jobs after fan-out, counted against the 32-job rail (CANVAS_CONFIRM_JOBS). */
  expectedJobs: number;
  /** Local estimate for the whole node after fan-out (§0.13). The run-all preview uses the server's. */
  estimate: CostEstimate;
  /** Fan-out factor k, shown as the ×k badge when above 1. */
  fanOut: number;
}

export type CompileResult = { ok: true; node: CompiledNode } | { ok: false; blocker: NodeBlocker };

/** The pure half of a node type. Data nodes implement it; annotation nodes don't. */
export interface NodeEngine<P = Record<string, unknown>> {
  fingerprintParams(node: EngineNode<P>, ctx: EngineContext): FingerprintParams;
  /** Values handed downstream: text for Prompt, assets for sources and finished runs, pending otherwise. */
  outputs(node: EngineNode<P>, inputs: ResolvedInputs, ctx: EngineContext, willRun: boolean): OutputValues;
  /** Why the node can't run right now, or null. */
  blocker(node: EngineNode<P>, inputs: ResolvedInputs, ctx: EngineContext): NodeBlocker | null;
  /** Runnable types only. */
  compile?(
    node: EngineNode<P>,
    inputs: ResolvedInputs,
    ctx: EngineContext,
    fingerprint: string,
  ): CompileResult;
}

// Live run state (not saved, not undoable)

export interface NodeRuntime {
  runId: string | null;
  /** From canvas_run.updated: queued, running, done, cached, failed, canceled or blocked. */
  state: CanvasNodeState;
  jobSetIds: readonly string[];
  /** Jobs finished and expected, for the progress bar and "2 of 6 done". */
  done: number;
  total: number;
  /** 0 to 1 over the node's jobs when the model reports progress; null draws an indeterminate bar. */
  progress: number | null;
  /** Its place in the company's queue, 1 first ("2nd in line"), from job.queued. Null until then. */
  position: number | null;
  startedAt: string | null;
  /** Newest job.partial frame, until the final image lands. */
  partialThumbUrl: string | null;
  error: { code: ErrorCode; reason?: string } | null;
  blocker: NodeBlocker | null;
  /** Skipped by the last run because nothing changed: the "Up to date" chip. */
  skipped: boolean;
  /** The result arrived after the node changed: "Made with older settings". */
  late: boolean;
}

export const idleRuntime = (): NodeRuntime => ({
  runId: null,
  state: "idle",
  jobSetIds: [],
  done: 0,
  total: 0,
  progress: null,
  position: null,
  startedAt: null,
  partialThumbUrl: null,
  error: null,
  blocker: null,
  skipped: false,
  late: false,
});

/** What a node draws: one state band plus an optional chip (§7.5 node states). */
export interface NodeDisplay {
  state: CanvasNodeState;
  chip: "up_to_date" | "inputs_changed" | "older_settings" | null;
  blocker: NodeBlocker | null;
  /** ×k when a list fans out into this node. */
  fanOut: number;
}

// The run controller: installed on the store by the engine, called by the editor and the nodes

export interface RunRequest {
  scope: CanvasRunScope;
  /** node and downstream: one id. selection: the selected ids. all: ignored. */
  nodeIds: readonly string[];
  bypassCache?: boolean;
  /** Where a confirmation opens: the pressed run pill or button. Defaults to the node's pill or Run all. */
  anchor?: Element | null;
}

export interface RunController {
  /** False until the engine has mounted. Run buttons stay disabled until then. */
  readonly ready: boolean;
  /** Compiles, asks when it has to (earlier nodes, run-all preview, over 32 jobs), then posts. */
  run(request: RunRequest): Promise<void>;
  /** Top bar Stop: cancels every active run on this canvas. */
  stop(): Promise<void>;
  /** A node band's Cancel: that node's job sets only. */
  cancelNode(nodeId: string): Promise<void>;
}

export const NOOP_RUN_CONTROLLER: RunController = {
  ready: false,
  run: async () => {},
  stop: async () => {},
  cancelNode: async () => {},
};

// The server's side of a run (§8.3), under the names the engine uses.

/** Why the server held a node back. */
export type RunBlockReason = CanvasBlockReason;
/** One row of the run response's `nodes`: what a node will cost and whether it runs at all. */
export type RunNodeSummary = CanvasRunNodeResult;
/** One node of a canvas_run.updated frame. */
export type RunNodeState = CanvasRunNodeState;
/** The whole state of one run, as canvas_run.updated and GET …/runs send it. */
export type RunState = CanvasRunState;
