import {
  compileRun,
  type EngineContext,
  fromDocument,
  planFingerprints,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import {
  CANVAS_CONFIRM_JOBS,
  CANVAS_RUN_MAX_JOBS,
  type CancelResponse,
  type CanvasActor,
  type CanvasBlockReason,
  type CanvasRunBody,
  type CanvasRunCall,
  type CanvasRunError,
  type CanvasRunNodeResult,
  type CanvasRunNodeState,
  type CanvasRunPlanItem,
  type CanvasRunResponse,
  type CanvasRunScopeBody,
  type CanvasRunScopeResponse,
  type CanvasRunState,
  type CostEstimate,
  canvasRunScopeBodySchema,
  ERROR_CODES,
  type ErrorCode,
  type GenerateRequest,
  generateRequestSchema,
  isTerminalState,
  type JobSetState,
  type ModelManifest,
  newId,
  type ProviderSummary,
  type ReferenceInput,
  type SpeedId,
  safeParseModelKey,
  t,
} from "@openfield/core";
import {
  type CanvasOutput,
  type CanvasRunLaunch,
  type CanvasRunRecord,
  canvasRunRecordSchema,
  freeEstimate,
  resultOfRunNode,
  scaleCostEstimate,
  sumCostEstimates,
} from "@openfield/core/canvas";
import {
  activeCanvasRuns,
  addToFolder,
  type CanvasRunRow,
  canvasRunsSince,
  createFolder,
  type Db,
  getAssets,
  getCanvas,
  getCanvasRun,
  getFolder,
  getJobSetBundle,
  getJobSetByIdempotencyKey,
  getModel,
  getProvider,
  insertCanvasRun,
  setCanvasFolder,
  updateCanvasRun,
} from "@openfield/db";
import { estimate, pricedOp, resolveProviderSettings } from "@openfield/providers/manifest";
import type { EventHub } from "../events/hub";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import type { Runner } from "../runner/runner";
import type { CredentialService } from "../services/credentials";
import type { ModelService } from "../services/models";
import type { ProviderSettingsService } from "../services/provider-settings";
import { blockerMessage } from "./blockers";
import { readDocument } from "./documents";

// Canvas runs (§7.7, M4-10). The browser compiles the graph into a plan; this schedules it.
// Items start when everything they read from has finished, through the ordinary job queue, so
// ordering, concurrency, retries, speeds and restarts are the runner's and the queue's: a node's
// images run at its company's speed, and one a restart cuts off takes §0.4's paths like any other.
//
// Node state is recomputed from its job sets rather than patched from events, so a missed event,
// a restart or a cancel can't leave a node out of step. Each job set is re-read only when an event
// names it. When a node settles, its result goes into the saved canvas too, so a canvas closed
// during a run opens with it (§7.8).

/** canvas_run.updated at most this often per run (§7.10: batched, 10 a second). */
const EMIT_INTERVAL_MS = 100;
const NODE_OK: readonly CanvasRunNodeState["state"][] = ["done", "cached"];
const NODE_TERMINAL: readonly CanvasRunNodeState["state"][] = [
  "done",
  "cached",
  "failed",
  "canceled",
  "blocked",
];
/** Job events that can move a node on. Progress and queue position go to the browser directly. */
const TRACKED = new Set(["job.started", "job.output", "job.failed", "job.canceled", "job_set.completed"]);

export interface CanvasRunDeps {
  db: Db;
  runner: Runner;
  models: ModelService;
  credentials: CredentialService;
  /** The company's speed, which prices each call as the runner will freeze it (§0.3). */
  providerSettings: ProviderSettingsService;
  events: EventHub;
  logger: Logger;
  /**
   * Puts settled nodes into the saved canvas. Each becomes a result there with resultOfRunNode,
   * which needs the result the node had.
   */
  writeResults?(canvasId: string, nodes: ReadonlyMap<string, CanvasRunNodeState>, at: string): void;
  /** The engine's view of models and settings, for runs compiled here (runScope). */
  engineContext?: () => EngineContext;
  /** Company names, for what a blocked node says. */
  providerSummaries?: () => ProviderSummary[];
  /** Saves "Before <agent>" before an agent session's first change to a canvas. Its id, or null. */
  saveAgentVersion?(canvasId: string, actor: CanvasActor): string | null;
}

interface NodeRun {
  item: CanvasRunPlanItem;
  /** Earlier items whose images this one reads. */
  deps: string[];
  state: CanvasRunNodeState;
  /** Its job sets have been planned (or it never needed any). */
  launched: boolean;
  /** Its result has gone into the saved canvas. */
  written: boolean;
}

/** One job set's part in its node, read again from the database only when an event names it. */
interface SetView {
  finished: boolean;
  started: boolean;
  done: number;
  canceled: boolean;
  /** Failed or interrupted jobs: the node comes back short. */
  failed: number;
  firstError: CanvasRunError | null;
  startedAt: string | null;
  outputs: { assetId: string; costUsd: number | null }[];
}

interface ActiveRun {
  id: string;
  canvasId: string;
  scope: CanvasRunState["scope"];
  priority: number;
  createdAt: string;
  status: JobSetState;
  finishedAt: string | null;
  record: CanvasRunRecord;
  /** In plan order, which is upstream first. */
  nodes: Map<string, NodeRun>;
  /** createJobSet calls still in progress. The run can't finish while any are. */
  launching: number;
  dirty: Set<string>;
  /** Job sets an event named since they were last read. */
  dirtySets: Set<string>;
  sets: Map<string, SetView>;
  processQueued: boolean;
  emitTimer: ReturnType<typeof setTimeout> | undefined;
  lastEmit: number;
  /** Images already filed into the canvas folder, and that folder once known. */
  filed: Set<string>;
  folderId?: string;
}

interface Analysis {
  skipped: boolean;
  blocked: CanvasBlockReason | null;
  /** Images it hands downstream: its jobs, or its cached images. */
  expectedOut: number;
  jobs: number;
  estimate: CostEstimate;
}

export class CanvasRunService {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #jobSetRun = new Map<string, string>();
  #unsubscribe: (() => void) | undefined;
  #stopped = false;

  constructor(private readonly deps: CanvasRunDeps) {}

  /** Starts following job events. Call before recover(). */
  start(): void {
    this.#unsubscribe = this.deps.events.subscribe((event, data) => {
      if (!TRACKED.has(event)) return;
      const jobSetId = (data as { jobSetId?: string }).jobSetId;
      const runId = jobSetId ? this.#jobSetRun.get(jobSetId) : undefined;
      const run = runId ? this.#runs.get(runId) : undefined;
      if (!run || !jobSetId) return;
      const nodeId = run.record.launches.find((l) => l.jobSetId === jobSetId)?.nodeId;
      if (!nodeId) return;
      run.dirtySets.add(jobSetId);
      this.#touch(run, nodeId);
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    for (const run of this.#runs.values()) if (run.emitTimer) clearTimeout(run.emitTimer);
  }

  // Starting a run

  /** POST /api/canvases/:id/run */
  async run(canvasId: string, body: CanvasRunBody): Promise<CanvasRunResponse> {
    if (!getCanvas(this.deps.db, canvasId)) {
      throw new ApiFailure(404, "not_found", "That canvas doesn't exist", { field: "id" });
    }
    const deps = this.#checkOrder(body.plan);
    this.#checkNotRunning(canvasId, body.plan);
    const analysis = this.#analyse(body.plan, deps);

    const rows: CanvasRunNodeResult[] = body.plan.map((item) => {
      const a = analysis.get(item.nodeId)!;
      return {
        nodeId: item.nodeId,
        jobs: a.jobs,
        estimate: a.estimate,
        skipped: a.skipped,
        blocked: a.blocked,
      };
    });
    const jobs = rows.reduce((sum, r) => sum + r.jobs, 0);
    // Refused before anything is built: a fan-out can multiply into more than any machine holds.
    if (jobs > CANVAS_RUN_MAX_JOBS) {
      throw new ApiFailure(409, "conflict", `This run makes ${jobs} jobs`, {
        field: "plan",
        userMessage: t("canvas.errors.tooManyJobs", { max: CANVAS_RUN_MAX_JOBS }),
      });
    }
    const total = sumCostEstimates(rows.filter((r) => r.jobs > 0).map((r) => r.estimate));
    const skipped = rows
      .filter((r) => r.skipped)
      .map((r) => ({ nodeId: r.nodeId, reason: "cached" as const }));

    if (body.dryRun) return { runId: null, jobSets: [], skipped, estimate: total, jobs, nodes: rows };
    if (jobs > CANVAS_CONFIRM_JOBS && !body.confirmed) {
      throw new ApiFailure(409, "conflict", `This run makes ${jobs} jobs and wasn't confirmed`, {
        field: "confirmed",
        userMessage: t("canvas.errors.confirmJobs", { count: jobs }),
      });
    }

    const run = this.#create(canvasId, body, deps, analysis);
    await this.#advance(run);
    this.#process(run);
    const jobSets = run.record.launches
      .filter((l) => l.jobSetId !== null)
      .map((l) => ({ nodeId: l.nodeId, jobSetId: l.jobSetId! }));
    return { runId: run.id, jobSets, skipped, estimate: total, jobs, nodes: rows };
  }

  /** Every node value must point at an earlier item, so the plan runs in the order it was sent. */
  /** Nodes of this canvas queued or running now. */
  busyNodes(canvasId: string): Set<string> {
    const busy = new Set<string>();
    for (const run of this.#runs.values()) {
      if (run.canvasId !== canvasId) continue;
      for (const node of run.nodes.values()) {
        if (!NODE_TERMINAL.includes(node.state.state)) busy.add(node.item.nodeId);
      }
    }
    return busy;
  }

  /**
   * A run asked for by scope rather than by plan (§7.11): the saved canvas is compiled here with the
   * editor's own engine, so an agent runs a canvas exactly as its Run button would, with or without
   * a tab open. Open tabs follow it on canvas_run.updated like any other run.
   */
  async runScope(
    canvasId: string,
    input: CanvasRunScopeBody,
    actor?: CanvasActor,
  ): Promise<CanvasRunScopeResponse> {
    const body = canvasRunScopeBodySchema.parse(input);
    const row = getCanvas(this.deps.db, canvasId);
    if (!row) throw new ApiFailure(404, "not_found", "That canvas doesn't exist", { field: "id" });
    if (!this.deps.engineContext) throw new Error("runScope needs an engine context");
    const ctx = this.deps.engineContext();
    const { slice } = fromDocument(readDocument(row.graph));
    const fingerprints = await resolveFingerprints(planFingerprints(slice, specRegistry, ctx), new Map());
    const outcome = compileRun({
      doc: slice,
      registry: specRegistry,
      ctx,
      fingerprints,
      request: {
        scope: body.scope,
        nodeIds: body.nodeIds,
        ...(body.bypassCache !== undefined && { bypassCache: body.bypassCache }),
        ...(body.includeUpstream !== undefined && { includeUpstream: body.includeUpstream }),
      },
      busy: this.busyNodes(canvasId),
    });
    const none: CanvasRunScopeResponse = {
      outcome: "nothing",
      runId: null,
      planned: [],
      upToDate: [],
      blocked: [],
      upstream: [],
      jobs: 0,
      estimate: freeEstimate(),
      nodes: [],
      jobSets: [],
    };
    if (outcome.kind === "cycle") {
      throw new ApiFailure(409, "conflict", "Every node asked for is in a loop", {
        userMessage: t("canvas.nodes.blocked.loop"),
      });
    }
    if (outcome.kind === "busy") return { ...none, outcome: "busy" };
    if (outcome.kind === "needs_upstream")
      return { ...none, outcome: "needs_upstream", upstream: outcome.nodeIds };

    const providers = this.deps.providerSummaries?.() ?? [];
    const blocked = Object.entries(outcome.blocked).map(([nodeId, blocker]) => ({
      nodeId,
      reason: blocker.kind,
      message: blockerMessage(blocker, providers),
    }));
    const planned = outcome.items.map((c) => c.item.nodeId);
    if (!planned.length) return { ...none, blocked, upToDate: outcome.upToDate };

    const versionId =
      !body.dryRun && actor?.kind === "agent"
        ? (this.deps.saveAgentVersion?.(canvasId, actor) ?? null)
        : null;
    const response = await this.run(canvasId, {
      scope: body.scope,
      nodeIds: body.nodeIds,
      plan: outcome.items.map((c) => c.item),
      ...(body.dryRun !== undefined && { dryRun: body.dryRun }),
      ...(body.confirmed !== undefined && { confirmed: body.confirmed }),
    });
    if (!body.dryRun && actor?.kind === "agent") {
      this.deps.events.publish("agent.activity", {
        canvasId,
        actor,
        nodeIds: planned,
        kind: "running",
        at: new Date().toISOString(),
        versionId,
      });
    }
    return {
      outcome: "plan",
      runId: response.runId,
      planned,
      upToDate: outcome.upToDate,
      blocked,
      upstream: [],
      jobs: response.jobs,
      estimate: response.estimate,
      nodes: response.nodes,
      jobSets: response.jobSets,
    };
  }

  #checkOrder(plan: CanvasRunPlanItem[]): Map<string, string[]> {
    const seen = new Set<string>();
    const deps = new Map<string, string[]>();
    plan.forEach((item, i) => {
      if (seen.has(item.nodeId)) {
        throw new ApiFailure(400, "bad_request", `${item.nodeId} is in the plan twice`, {
          field: `plan.${i}.nodeId`,
        });
      }
      const reads = new Set<string>();
      for (const [j, input] of item.inputs.entries()) {
        for (const [k, value] of input.values.entries()) {
          if (value.kind !== "node") continue;
          if (!seen.has(value.nodeId)) {
            throw new ApiFailure(400, "bad_request", `${value.nodeId} must come before ${item.nodeId}`, {
              field: `plan.${i}.inputs.${j}.values.${k}.nodeId`,
            });
          }
          reads.add(value.nodeId);
        }
      }
      deps.set(item.nodeId, [...reads]);
      seen.add(item.nodeId);
    });
    return deps;
  }

  /** A node already waiting or working in another run isn't sent again: it would be paid for twice. */
  #checkNotRunning(canvasId: string, plan: CanvasRunPlanItem[]): void {
    const busy = this.busyNodes(canvasId);
    const at = plan.findIndex((item) => busy.has(item.nodeId));
    if (at >= 0) {
      throw new ApiFailure(409, "conflict", `${plan[at]!.nodeId} is already running`, {
        field: `plan.${at}.nodeId`,
        userMessage: t("canvas.run.busy"),
      });
    }
  }

  /** What each item will do: skip, wait on a fix, or make this many images for about this much. */
  #analyse(plan: CanvasRunPlanItem[], deps: Map<string, string[]>): Map<string, Analysis> {
    const out = new Map<string, Analysis>();
    const assetIds = plan.flatMap((item) =>
      item.inputs.flatMap((input) => input.values.flatMap((v) => (v.kind === "asset" ? [v.assetId] : []))),
    );
    const present = new Set(
      getAssets(this.deps.db, [...new Set(assetIds)])
        .filter((a) => a.fileState === "ok")
        .map((a) => a.id),
    );
    for (const item of plan) {
      const upstream = deps.get(item.nodeId)!.map((id) => out.get(id)!);
      // Reusing a result only holds while everything it read is reused too: new images upstream
      // under the same settings (a bypass, a file gone missing) mean new inputs here.
      if (upstream.every((u) => u.skipped) && this.#cacheHit(item)) {
        const n = item.cached!.assetIds.length;
        out.set(item.nodeId, {
          skipped: true,
          blocked: null,
          expectedOut: n,
          jobs: 0,
          estimate: freeEstimate(),
        });
        continue;
      }
      const missing = item.inputs.some((input) =>
        input.values.some((v) => v.kind === "asset" && !present.has(v.assetId)),
      );
      const upstreamBad = upstream.some((u) => u.blocked !== null || u.expectedOut === 0);
      const blocked =
        this.#modelBlock(item) ?? (missing ? "missing_asset" : upstreamBad ? "upstream_failed" : null);
      if (blocked) {
        out.set(item.nodeId, { skipped: false, blocked, expectedOut: 0, jobs: 0, estimate: freeEstimate() });
        continue;
      }
      const fanOut = item.inputs
        .filter((input) => input.arity === "single")
        .reduce((product, input) => {
          const count = input.values.reduce(
            (sum, v) => sum + (v.kind === "asset" ? 1 : out.get(v.nodeId)!.expectedOut),
            0,
          );
          return product * Math.max(1, count);
        }, 1);
      const perRun = item.calls.reduce((sum, call) => sum + call.batch, 0);
      const cost = scaleCostEstimate(sumCostEstimates(item.calls.map((c) => this.#estimate(c))), fanOut);
      out.set(item.nodeId, {
        skipped: false,
        blocked: null,
        expectedOut: perRun * fanOut,
        jobs: perRun * fanOut,
        estimate: cost,
      });
    }
    return out;
  }

  /** Unchanged since its last run, and every image from that run is still in the library (§0.11). */
  #cacheHit(item: CanvasRunPlanItem): boolean {
    const cached = item.cached;
    if (item.bypassCache || !cached || cached.fingerprint !== item.fingerprint) return false;
    if (cached.assetIds.length === 0) return false;
    const live = getAssets(this.deps.db, cached.assetIds);
    return live.length === new Set(cached.assetIds).size && live.every((a) => a.fileState === "ok");
  }

  /** Why a model can't run right now, or null. Checked for every call the node makes. */
  #modelBlock(item: CanvasRunPlanItem): CanvasBlockReason | null {
    for (const call of item.calls) {
      const key = safeParseModelKey(call.model);
      const manifest = this.deps.models.get(call.model);
      if (!key || !manifest) return "model_unavailable";
      if (getModel(this.deps.db, key.providerId, key.modelId)?.enabled === false) return "model_unavailable";
      if (getProvider(this.deps.db, key.providerId)?.enabled === false) return "company_off";
      if (!this.deps.credentials.usable(key.providerId)) return "no_key";
    }
    return null;
  }

  /** Priced at the speed the company's settings resolve to for this model, as the runner will run it. */
  #estimate(call: CanvasRunCall): CostEstimate {
    const manifest = this.deps.models.get(call.model);
    if (!manifest) return { ...freeEstimate(), confidence: "unknown" };
    const size = call.size;
    return estimate(manifest, {
      batch: call.batch,
      prompt: call.prompt,
      op: call.op,
      speed: this.#speed(manifest, call),
      ...(call.resolution && { resolution: call.resolution }),
      ...(call.quality && { quality: call.quality }),
      ...(size.kind === "aspect" && { size: { aspect: size.ratio } }),
      ...(size.kind === "pixels" && { size: { width: size.width, height: size.height } }),
    });
  }

  #speed(manifest: ModelManifest, call: CanvasRunCall): SpeedId {
    try {
      const { schema, stored } = this.deps.providerSettings.forRun(manifest.providerId);
      return resolveProviderSettings(schema, stored, manifest, pricedOp(call.op)).speed;
    } catch {
      return "standard";
    }
  }

  #create(
    canvasId: string,
    body: CanvasRunBody,
    deps: Map<string, string[]>,
    analysis: Map<string, Analysis>,
  ): ActiveRun {
    const id = newId();
    const createdAt = new Date().toISOString();
    const nodes = new Map<string, NodeRun>();
    for (const item of body.plan) {
      const a = analysis.get(item.nodeId)!;
      const state = blankState(item);
      if (a.skipped) {
        state.state = "cached";
        state.assetIds = [...item.cached!.assetIds];
        state.outputs = item.cached!.assetIds.map((assetId) => ({ assetId }));
        state.finishedAt = createdAt;
      } else if (a.blocked) {
        state.state = "blocked";
        state.blocked = a.blocked;
        state.finishedAt = createdAt;
      } else {
        state.total = a.jobs;
      }
      nodes.set(item.nodeId, {
        item,
        deps: deps.get(item.nodeId)!,
        state,
        launched: a.skipped || !!a.blocked,
        written: false,
      });
    }
    const record: CanvasRunRecord = {
      nodeIds: body.nodeIds,
      items: body.plan,
      launches: [],
      canceled: false,
      canceledNodes: [],
    };
    // A single node goes in beside the composer's runs; one that brings earlier nodes along
    // (Run them too) is a batch like any other and waits its turn (§0.12).
    const willRun = body.plan.filter((item) => {
      const a = analysis.get(item.nodeId)!;
      return !a.skipped && !a.blocked;
    }).length;
    const priority = body.scope === "node" && willRun <= 1 ? 10 : 5;
    insertCanvasRun(this.deps.db, {
      id,
      canvasId,
      scope: body.scope,
      status: "running",
      plan: record,
      nodes: [...nodes.values()].map((n) => n.state),
      priority,
      createdAt,
    });
    const run = this.#track({ id, canvasId, scope: body.scope, priority, createdAt, record, nodes });
    this.#emitNow(run);
    return run;
  }

  #track(
    fields: Pick<ActiveRun, "id" | "canvasId" | "scope" | "priority" | "createdAt" | "record" | "nodes">,
  ) {
    const run: ActiveRun = {
      ...fields,
      status: "running",
      finishedAt: null,
      launching: 0,
      dirty: new Set(),
      dirtySets: new Set(),
      sets: new Map(),
      processQueued: false,
      emitTimer: undefined,
      lastEmit: 0,
      filed: new Set(),
    };
    this.#runs.set(run.id, run);
    return run;
  }

  // Moving a run along

  /** Starts every item whose inputs are ready. Upstream failures block what depends on them. */
  async #advance(run: ActiveRun): Promise<void> {
    if (!this.#runs.has(run.id)) return;
    const starting: Promise<void>[] = [];
    for (const node of run.nodes.values()) {
      if (node.launched || NODE_TERMINAL.includes(node.state.state)) continue;
      if (this.#stopping(run, node.item.nodeId)) {
        node.launched = true;
        node.state = { ...node.state, state: "canceled", total: 0 };
        run.dirty.add(node.item.nodeId);
        continue;
      }
      const upstream = node.deps.map((id) => run.nodes.get(id)!);
      if (upstream.some((u) => !NODE_TERMINAL.includes(u.state.state))) continue;
      const broken = upstream.find((u) => !NODE_OK.includes(u.state.state) || u.state.assetIds.length === 0);
      if (broken) {
        node.launched = true;
        node.state =
          broken.state.state === "canceled"
            ? { ...node.state, state: "canceled", total: 0 }
            : { ...node.state, state: "blocked", blocked: "upstream_failed", total: 0 };
        run.dirty.add(node.item.nodeId);
        continue;
      }
      node.launched = true;
      starting.push(this.#launch(run, node));
    }
    await Promise.all(starting);
  }

  /**
   * Plans the node's job sets (one per call, per fanned-out input), records them with their
   * idempotency keys first, then creates them. A restart finishes whatever was recorded.
   */
  async #launch(run: ActiveRun, node: NodeRun): Promise<void> {
    const launches = this.#plan(run, node);
    run.record.launches.push(...launches);
    node.state = { ...node.state, total: launches.reduce((sum, l) => sum + l.request.batch, 0) };
    this.#saveRecord(run);
    run.launching++;
    try {
      for (const launch of launches) await this.#createJobSet(run, launch);
    } finally {
      run.launching--;
      this.#saveRecord(run);
      this.#touch(run, node.item.nodeId);
    }
  }

  #plan(run: ActiveRun, node: NodeRun): CanvasRunLaunch[] {
    const { item } = node;
    const resolved = item.inputs.map((input) => ({
      input,
      assetIds: input.values.flatMap((v) =>
        v.kind === "asset" ? [v.assetId] : this.#produced(run, v.nodeId),
      ),
    }));
    const multi = resolved.filter((r) => r.input.arity === "multi");
    const singles = resolved.filter((r) => r.input.arity === "single");
    // Cartesian product over single inputs: a list into a single input runs once per image (§7.7).
    // #analyse already refused anything over CANVAS_RUN_MAX_JOBS, so this stays small.
    let combos: (string | null)[][] = [[]];
    for (const single of singles) {
      const options = single.assetIds.length ? single.assetIds : [null];
      combos = combos.flatMap((combo) => options.map((id) => [...combo, id]));
    }

    const launches: CanvasRunLaunch[] = [];
    combos.forEach((combo, source) => {
      const bound = [
        ...multi.flatMap((m) => m.assetIds.map((assetId) => ({ input: m.input, assetId }))),
        ...singles.flatMap((s, i) => (combo[i] ? [{ input: s.input, assetId: combo[i]! }] : [])),
      ];
      const references: ReferenceInput[] = bound
        .filter((b) => b.input.to === "references")
        .map((b) => ({ assetId: b.assetId, role: b.input.role ?? "subject" }));
      const base = bound.find((b) => b.input.to === "base");
      const mask = bound.find((b) => b.input.to === "mask");
      item.calls.forEach((call, callIndex) => {
        const { label: _label, seed, ...settings } = call;
        const request: GenerateRequest = {
          ...settings,
          idempotencyKey: newId(),
          ...(seed !== null && seed !== undefined && { seed }),
          ...(references.length && { references }),
          ...(base && { base: { assetId: base.assetId, role: base.input.role ?? "base" } }),
          ...(mask && { mask: { assetId: mask.assetId } }),
          source: "canvas",
          canvas: { canvasId: run.canvasId, nodeId: item.nodeId },
        };
        const valid = generateRequestSchema.safeParse(request);
        launches.push({
          nodeId: item.nodeId,
          call: callIndex,
          source,
          request: valid.success ? valid.data : request,
          jobSetId: null,
          error: valid.success
            ? null
            : { code: "invalid_request", reason: valid.error.issues[0]?.message ?? "Invalid request" },
        });
      });
    });
    return launches;
  }

  /** Images an upstream item made, in job set order then output order, or its cached ones. */
  #produced(run: ActiveRun, nodeId: string): string[] {
    return run.nodes.get(nodeId)?.state.assetIds ?? [];
  }

  /** Stop, or this node's own Cancel, was pressed. */
  #stopping(run: ActiveRun, nodeId: string): boolean {
    return run.record.canceled || run.record.canceledNodes.includes(nodeId);
  }

  async #createJobSet(run: ActiveRun, launch: CanvasRunLaunch): Promise<void> {
    if (launch.jobSetId || launch.error) return;
    if (this.#stopping(run, launch.nodeId)) {
      launch.error = { code: "canceled" };
      return;
    }
    try {
      const accepted = await this.deps.runner.createJobSet(launch.request, {
        priority: run.priority,
        canvasRunId: run.id,
      });
      launch.jobSetId = accepted.jobSet.id;
      this.#jobSetRun.set(accepted.jobSet.id, run.id);
      // Stop, or the node's Cancel, was pressed while this was being created.
      if (this.#stopping(run, launch.nodeId)) this.deps.runner.cancelJobSet(accepted.jobSet.id);
    } catch (err) {
      // The canvas was deleted, or Stop pressed, while this was being created: nothing started.
      if (this.#stopping(run, launch.nodeId) || !this.#runs.has(run.id)) {
        launch.error = { code: "canceled" };
        return;
      }
      launch.error = launchError(err);
      if (!(err instanceof ApiFailure)) {
        this.deps.logger.error("A canvas node couldn't start", {
          runId: run.id,
          nodeId: launch.nodeId,
          error: err,
        });
      }
    }
  }

  /** Marks a node for recomputing and processes the run soon, once per task. */
  #touch(run: ActiveRun, nodeId: string): void {
    run.dirty.add(nodeId);
    if (run.processQueued || this.#stopped) return;
    run.processQueued = true;
    queueMicrotask(() => {
      run.processQueued = false;
      this.#process(run);
    });
  }

  #process(run: ActiveRun): void {
    if (!this.#runs.has(run.id)) return;
    const dirty = [...run.dirty];
    run.dirty.clear();
    for (const nodeId of dirty) {
      const node = run.nodes.get(nodeId);
      if (node) this.#recompute(run, node);
    }
    // Starts what's ready. Its synchronous part marks nodes launched before this returns.
    void this.#advance(run).catch((error) =>
      this.deps.logger.error("A canvas run couldn't continue", { runId: run.id, error }),
    );
    this.#settle(run);
    if (!this.#finishIfDone(run)) this.#emitSoon(run);
  }

  /** A job set's jobs and images. Read from the database again only once an event named it. */
  #view(run: ActiveRun, jobSetId: string): SetView | undefined {
    const cached = run.sets.get(jobSetId);
    if (cached && !run.dirtySets.has(jobSetId)) return cached;
    run.dirtySets.delete(jobSetId);
    const bundle = getJobSetBundle(this.deps.db, jobSetId);
    if (!bundle) return undefined;
    const view: SetView = {
      finished: isTerminalState(bundle.jobSet.status),
      started: false,
      done: 0,
      canceled: false,
      failed: 0,
      firstError: null,
      startedAt: null,
      outputs: [],
    };
    const assetOf = new Map(bundle.assets.map((a) => [a.jobId, a]));
    for (const job of bundle.jobs) {
      if (job.status !== "pending") view.started = true;
      if (job.startedAt && (!view.startedAt || job.startedAt < view.startedAt))
        view.startedAt = job.startedAt;
      if (isTerminalState(job.status)) view.done++;
      if (job.status === "canceled") view.canceled = true;
      if (job.status === "failed" || job.status === "interrupted") {
        view.failed++;
        view.firstError ??=
          job.status === "interrupted"
            ? { code: "unknown", reason: t("canvas.errors.interrupted") }
            : { code: job.errorCode ?? "unknown", ...(job.errorReason && { reason: job.errorReason }) };
      }
      const asset = assetOf.get(job.id);
      if (job.status === "succeeded" && asset)
        view.outputs.push({ assetId: asset.id, costUsd: asset.costUsd });
    }
    run.sets.set(jobSetId, view);
    return view;
  }

  /** A node's state from its job sets. */
  #recompute(run: ActiveRun, node: NodeRun): void {
    if (!node.launched || node.state.state === "cached" || node.state.state === "blocked") return;
    const launches = run.record.launches.filter((l) => l.nodeId === node.item.nodeId);
    if (launches.length === 0) return;
    const pending = launches.some((l) => !l.jobSetId && !l.error);
    const outputs: CanvasOutput[] = [];
    const jobSetIds: string[] = [];
    const inputs = new Set<string>();
    let done = 0;
    let started = false;
    let startedAt: string | null = null;
    let allSetsFinished = true;
    let cost = 0;
    let costKnown = false;
    let failures = 0;
    let firstError: CanvasRunError | null = null;
    let canceled = false;

    for (const launch of launches) {
      const req = launch.request;
      for (const r of req.references ?? []) inputs.add(r.assetId);
      if (req.base) inputs.add(req.base.assetId);
      if (req.mask) inputs.add(req.mask.assetId);
      if (launch.error) {
        if (launch.error.code === "canceled") canceled = true;
        else {
          failures++;
          firstError ??= launch.error;
        }
        continue;
      }
      if (!launch.jobSetId) continue;
      jobSetIds.push(launch.jobSetId);
      const view = this.#view(run, launch.jobSetId);
      if (!view) continue;
      if (!view.finished) allSetsFinished = false;
      started ||= view.started;
      if (view.startedAt && (!startedAt || view.startedAt < startedAt)) startedAt = view.startedAt;
      done += view.done;
      canceled ||= view.canceled;
      failures += view.failed;
      firstError ??= view.firstError;
      for (const output of view.outputs) {
        outputs.push({ assetId: output.assetId, model: req.model, call: launch.call, source: launch.source });
        if (output.costUsd !== null) {
          cost += output.costUsd;
          costKnown = true;
        }
      }
    }

    const total = launches.reduce((sum, l) => sum + (l.error ? 0 : l.request.batch), 0);
    const finished = !pending && allSetsFinished;
    let state: CanvasRunNodeState["state"];
    if (!finished) state = started || done > 0 ? "running" : "queued";
    // A stop part way through keeps the images that made it, but the node still says it was
    // stopped, so the next run makes the rest instead of reusing a short set (§7.7).
    else if (canceled && failures === 0) state = "canceled";
    // Short because some images failed or a restart cut them off: the images stay on show, the
    // error says why, and the set is never reused as if it were whole.
    else if (failures > 0 || outputs.length === 0) state = "failed";
    else state = "done";

    node.state = {
      ...node.state,
      state,
      jobSetIds,
      done,
      total,
      assetIds: outputs.map((o) => o.assetId),
      outputs,
      inputs: [...inputs].sort(),
      costUsd: costKnown ? Math.round(cost * 1e6) / 1e6 : null,
      error: state === "failed" ? (firstError ?? { code: "unknown" }) : null,
      blocked: null,
      startedAt,
    };
    this.#file(run, node.state.assetIds);
  }

  /**
   * Stamps nodes that just settled and puts their results into the saved canvas, so a canvas
   * closed during the run opens with them. A node that never started keeps the result it had.
   */
  #settle(run: ActiveRun): void {
    const now = new Date().toISOString();
    const settled = new Map<string, CanvasRunNodeState>();
    for (const node of run.nodes.values()) {
      if (!NODE_TERMINAL.includes(node.state.state)) continue;
      if (!node.state.finishedAt) node.state = { ...node.state, finishedAt: now };
      if (node.written) continue;
      node.written = true;
      // Nodes the run leaves alone aren't sent; the saved result decides the rest.
      if (resultOfRunNode(node.state, now)) settled.set(node.item.nodeId, node.state);
    }
    if (!settled.size || !this.deps.writeResults) return;
    try {
      this.deps.writeResults(run.canvasId, settled, now);
    } catch (error) {
      this.deps.logger.warn("Couldn't save a canvas run's results", { runId: run.id, error });
    }
  }

  /** Files new images into the canvas's own library folder, making it on first use (§7.1). */
  #file(run: ActiveRun, assetIds: string[]): void {
    const fresh = assetIds.filter((id) => !run.filed.has(id));
    if (fresh.length === 0) return;
    try {
      const { db } = this.deps;
      // Filing follows the folder's id, wherever the person renamed or moved it to (§0.7). One
      // deleted since the run's last filing is looked up again, which makes a new one.
      let folderId: string | null | undefined =
        run.folderId && getFolder(db, run.folderId) ? run.folderId : undefined;
      if (!folderId) {
        const canvas = getCanvas(db, run.canvasId);
        if (!canvas) return;
        folderId = canvas.folderId;
        // The person may have deleted the folder; a new one is made rather than filing nowhere.
        if (!folderId || !getFolder(db, folderId)) {
          folderId = createFolder(db, { id: newId(), name: canvas.name }).id;
          setCanvasFolder(db, canvas.id, folderId);
        }
        run.folderId = folderId;
      }
      addToFolder(db, folderId, fresh);
      for (const id of fresh) run.filed.add(id);
      this.deps.events.publish("folder.updated", { folderId, deleted: false });
    } catch (error) {
      this.deps.logger.warn("Couldn't file canvas images into their folder", { runId: run.id, error });
    }
  }

  #finishIfDone(run: ActiveRun): boolean {
    if (run.launching > 0) return false;
    const nodes = [...run.nodes.values()];
    if (!nodes.every((n) => NODE_TERMINAL.includes(n.state.state))) return false;
    run.status = runStatus(nodes.map((n) => n.state.state));
    run.finishedAt = new Date().toISOString();
    this.#emitNow(run);
    this.#runs.delete(run.id);
    for (const launch of run.record.launches) if (launch.jobSetId) this.#jobSetRun.delete(launch.jobSetId);
    return true;
  }

  // Stop, cancel one node, list, recover

  /** A run that already ended: nothing to cancel, its job sets listed as past canceling. */
  #ended(canvasId: string, runId: string): CancelResponse {
    const row = getCanvasRun(this.deps.db, runId);
    if (!row || row.canvasId !== canvasId) {
      throw new ApiFailure(404, "not_found", "That run doesn't exist", { field: "runId" });
    }
    const record = canvasRunRecordSchema.safeParse(row.plan);
    const ids = record.success ? record.data.launches.flatMap((l) => (l.jobSetId ? [l.jobSetId] : [])) : [];
    return { canceled: [], notCancelable: ids };
  }

  #cancelSets(run: ActiveRun, launches: readonly CanvasRunLaunch[]): CancelResponse {
    const out: CancelResponse = { canceled: [], notCancelable: [] };
    for (const launch of launches) {
      if (!launch.jobSetId) continue;
      const result = this.deps.runner.cancelJobSet(launch.jobSetId);
      (result.canceled.length ? out.canceled : out.notCancelable).push(launch.jobSetId);
      run.dirtySets.add(launch.jobSetId);
    }
    return out;
  }

  /** Top bar Stop: cancels every job set of the run; nodes that hadn't started are canceled at once. */
  cancel(canvasId: string, runId: string): CancelResponse {
    const run = this.#runs.get(runId);
    if (!run) return this.#ended(canvasId, runId);
    if (run.canvasId !== canvasId) throw new ApiFailure(404, "not_found", "That run doesn't exist");
    run.record.canceled = true;
    this.#saveRecord(run);
    const out = this.#cancelSets(run, run.record.launches);
    for (const node of run.nodes.values()) run.dirty.add(node.item.nodeId);
    this.#process(run);
    return out;
  }

  /**
   * A node band's Cancel (§7.7): that node's job sets, and the nodes that read from it, which
   * can't run without it. Everything else in the run carries on.
   */
  cancelNode(canvasId: string, runId: string, nodeId: string): CancelResponse {
    const run = this.#runs.get(runId);
    if (!run) return this.#ended(canvasId, runId);
    if (run.canvasId !== canvasId) throw new ApiFailure(404, "not_found", "That run doesn't exist");
    const node = run.nodes.get(nodeId);
    if (!node) throw new ApiFailure(404, "not_found", "That node isn't in this run", { field: "nodeId" });
    if (!run.record.canceledNodes.includes(nodeId)) run.record.canceledNodes.push(nodeId);
    this.#saveRecord(run);
    const out = this.#cancelSets(
      run,
      run.record.launches.filter((l) => l.nodeId === nodeId),
    );
    if (!node.launched) {
      node.launched = true;
      node.state = { ...node.state, state: "canceled", total: 0 };
    }
    for (const n of run.nodes.values()) run.dirty.add(n.item.nodeId);
    this.#process(run);
    return out;
  }

  /**
   * Deleting a canvas (§7.3): its runs stop first, so nothing more is sent or billed for a canvas
   * that's gone. Work already with a company can't be called back (§7.7); its images still land in
   * the library.
   */
  forgetCanvas(canvasId: string): void {
    for (const run of [...this.#runs.values()]) {
      if (run.canvasId !== canvasId) continue;
      run.record.canceled = true;
      this.#runs.delete(run.id);
      if (run.emitTimer) clearTimeout(run.emitTimer);
      run.emitTimer = undefined;
      for (const launch of run.record.launches) {
        if (!launch.jobSetId) continue;
        this.deps.runner.cancelJobSet(launch.jobSetId);
        this.#jobSetRun.delete(launch.jobSetId);
      }
    }
  }

  /** GET /api/canvases/:id/runs: live state for active runs, the stored state for finished ones. */
  list(canvasId: string, since?: string): CanvasRunState[] {
    return canvasRunsSince(this.deps.db, canvasId, since).map((row) => {
      const live = this.#runs.get(row.id);
      return live ? stateOf(live) : storedState(row);
    });
  }

  /**
   * Crash recovery (§8.4.5), after the runner's own pass: rebuilds every unfinished run from its
   * record, finishes launches that were recorded but never created, recomputes nodes from their
   * job sets and keeps scheduling what's left. Returns how many runs it picked up.
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const row of activeCanvasRuns(this.deps.db)) {
      const parsed = canvasRunRecordSchema.safeParse(row.plan);
      if (!parsed.success) {
        this.deps.logger.warn("A canvas run couldn't be picked up again", { runId: row.id });
        updateCanvasRun(this.deps.db, row.id, { status: "failed", finishedAt: new Date().toISOString() });
        continue;
      }
      const record = parsed.data;
      const stored = new Map(row.nodes.map((n) => [n.nodeId, n]));
      const nodes = new Map<string, NodeRun>();
      for (const item of record.items) {
        const deps = [
          ...new Set(
            item.inputs.flatMap((i) => i.values.flatMap((v) => (v.kind === "node" ? [v.nodeId] : []))),
          ),
        ];
        const before = stored.get(item.nodeId);
        const settled = before && (before.state === "cached" || before.state === "blocked");
        const launched = record.launches.some((l) => l.nodeId === item.nodeId);
        const state = settled
          ? { ...blankState(item), ...before }
          : { ...blankState(item), total: before?.total ?? 0 };
        nodes.set(item.nodeId, { item, deps, state, launched: launched || !!settled, written: !!settled });
      }
      const run = this.#track({
        id: row.id,
        canvasId: row.canvasId,
        scope: row.scope,
        priority: row.priority,
        createdAt: row.createdAt,
        record,
        nodes,
      });
      run.launching++;
      try {
        for (const launch of record.launches) {
          if (launch.jobSetId) {
            this.#jobSetRun.set(launch.jobSetId, run.id);
            continue;
          }
          if (launch.error) continue;
          const existing = getJobSetByIdempotencyKey(this.deps.db, launch.request.idempotencyKey);
          if (existing) {
            launch.jobSetId = existing.id;
            this.#jobSetRun.set(existing.id, run.id);
          } else {
            await this.#createJobSet(run, launch);
          }
        }
      } finally {
        run.launching--;
      }
      this.#saveRecord(run);
      for (const node of nodes.values()) run.dirty.add(node.item.nodeId);
      this.#process(run);
      count++;
    }
    return count;
  }

  // Persisting and emitting

  #saveRecord(run: ActiveRun): void {
    updateCanvasRun(this.deps.db, run.id, { plan: run.record });
  }

  #emitSoon(run: ActiveRun): void {
    if (run.emitTimer) return;
    const wait = EMIT_INTERVAL_MS - (Date.now() - run.lastEmit);
    if (wait <= 0) {
      this.#emitNow(run);
      return;
    }
    run.emitTimer = setTimeout(() => {
      run.emitTimer = undefined;
      if (this.#runs.has(run.id)) this.#emitNow(run);
    }, wait);
    run.emitTimer.unref?.();
  }

  #emitNow(run: ActiveRun): void {
    if (run.emitTimer) clearTimeout(run.emitTimer);
    run.emitTimer = undefined;
    run.lastEmit = Date.now();
    const state = stateOf(run);
    updateCanvasRun(this.deps.db, run.id, {
      nodes: state.nodes,
      status: state.status,
      finishedAt: state.finishedAt,
    });
    if (!this.#stopped) this.deps.events.publish("canvas_run.updated", state);
  }
}

function blankState(item: CanvasRunPlanItem): CanvasRunNodeState {
  return {
    nodeId: item.nodeId,
    state: "queued",
    fingerprint: item.fingerprint,
    jobSetIds: [],
    done: 0,
    total: 0,
    assetIds: [],
    outputs: [],
    inputs: [],
    costUsd: null,
    error: null,
    blocked: null,
    startedAt: null,
    finishedAt: null,
  };
}

/** succeeded when every node is done or up to date; partial when some are; else failed or canceled. */
function runStatus(states: CanvasRunNodeState["state"][]): JobSetState {
  const ok = states.filter((s) => NODE_OK.includes(s)).length;
  if (ok === states.length) return "succeeded";
  if (ok > 0) return "partial";
  if (states.some((s) => s === "failed" || s === "blocked")) return "failed";
  return "canceled";
}

function stateOf(run: ActiveRun): CanvasRunState {
  return {
    runId: run.id,
    canvasId: run.canvasId,
    scope: run.scope,
    status: run.status,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    nodes: [...run.nodes.values()].map((n) => n.state),
  };
}

function storedState(row: CanvasRunRow): CanvasRunState {
  return {
    runId: row.id,
    canvasId: row.canvasId,
    scope: row.scope,
    status: row.status,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    // Rows written before a field existed read with its default.
    nodes: row.nodes.map((n) => ({
      ...n,
      inputs: n.inputs ?? [],
      startedAt: n.startedAt ?? null,
      finishedAt: n.finishedAt ?? null,
    })),
  };
}

/** A refused request becomes the node's failure, in the §0.5 vocabulary the band knows. */
function launchError(err: unknown): CanvasRunError {
  if (err instanceof ApiFailure) {
    const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(err.code)
      ? (err.code as ErrorCode)
      : "invalid_request";
    return { code, ...(err.userMessage && { reason: err.userMessage }) };
  }
  return { code: "unknown" };
}
