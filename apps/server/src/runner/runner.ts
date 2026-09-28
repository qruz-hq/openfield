import {
  type CancelResponse,
  type CostEstimate,
  type ErrorAction,
  formatMoney,
  type GenerateRequest,
  isTerminalState,
  type JobHandle,
  type JobSetAccepted,
  type JobState,
  type ModelManifest,
  type NormalizedRequest,
  newId,
  type Op,
  parseModelKey,
  type SpeedId,
  speedName,
  t,
} from "@openfield/core";
import {
  activeJobs,
  canceledWithHandle,
  clearCanceledHandles,
  createJobSet,
  type Db,
  getAssets,
  getJob,
  getJobSet,
  getJobSetByIdempotencyKey,
  getProvider,
  type JobRow,
  type JobSetRow,
  jobsOf,
  listProviders,
  recordKeyCheck,
  refreshJobSetStatus,
  restartPath,
  storeCanceledHandle,
  storeJobHandle,
  transitionJob,
  updateJob,
} from "@openfield/db";
import { estimate, pricedOp, resolveSpeed, resumesAfterRestart } from "@openfield/providers/manifest";
import {
  type CallContext,
  type JobResult,
  type JobUpdate,
  normalize,
  ProviderError,
  planCalls,
} from "@openfield/providers/server";
import type { EventHub } from "../events/hub";
import type { AttemptSink, Ingest } from "../files/ingest";
import type { Thumbs } from "../files/thumbs";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import { toJobSetWithJobs } from "../mappers/job";
import type { CredentialService } from "../services/credentials";
import type { BoundModel, ModelService } from "../services/models";
import type { ProviderSettingsService } from "../services/provider-settings";
import { asksForPrice, type RemotePrices } from "../services/remote-prices";
import type { SettingsService } from "../services/settings";
import { asProviderError, BatchWatcher, refused, untilAborted } from "./batches";
import { batchAction, callsFor, eachFromSet, finalReason, Outcomes } from "./outcomes";
import { type CallContexts, noWrites } from "./provider-fetch";
import {
  batchPollDelay,
  busyDelay,
  MISSES_PAST_DEADLINE,
  pollDelay,
  QUEUE_DEFAULTS,
  type QueueOptions,
  retryDelay,
  runTimeouts,
  sleep,
} from "./timing";

// The job queue (§8.4, §0.12): an in-process scheduler with SQLite as its durable state.
// One unit is one provider call: a single job on fan-out, every job of a set when the model
// takes a batch natively, or a whole Batch run's create call. Every state change goes through a
// guarded transition, so a late result can never overwrite a cancel.
//
// Restarts (§0.4): a call the model declares resumable has its handle stored the moment submit()
// returns, and from then on it's only ever read by that id, never sent again, and ends only on the
// company's own answer. Before that, a create whose answer was lost goes again only where the
// company honours the idempotency key (idempotentSubmit), which hands back the first call. At boot
// the scheduler picks such calls up by id before anything new goes out. Stopping waits for calls
// that can't resume and leaves resumable ones running at the company for the next start. A Batch
// run takes the same three steps (store the id before waiting, pick it up by id at boot, fetch
// instead of resend) through the batch watcher and its provider_batches row.

const IN_FLIGHT: readonly JobState[] = ["submitting", "queued", "running"];

/** How long a new run waits for its company to answer a price, before it's priced as unknown. */
const PRICE_WAIT_MS = 4_000;

/** One image's price as `count` of them. */
function scaleCost(each: CostEstimate, count: number): CostEstimate {
  const total = Math.round(each.max * count * 1e6) / 1e6;
  return {
    ...each,
    min: total,
    max: total,
    basis: t("cost.basis", { count, each: formatMoney(each.max, each.currency, true) }),
  };
}

interface Unit {
  id: string;
  /** "batch": the create call of a Batch run, handed to the batch watcher. */
  kind: "call" | "batch";
  jobSetId: string;
  providerId: string;
  modelKey: string;
  jobIds: string[];
  abort: AbortController;
  bound?: BoundModel;
  call?: NormalizedRequest;
  handle?: JobHandle;
  /** Sent at a speed that survives a restart (§6.3): its handle is stored before the first poll. */
  resumable?: boolean;
  /** A stored handle to pick up by id instead of sending the call (§6.7). */
  reattach?: JobHandle;
  /** Left running at the company when the server stopped, for the next start to pick up. */
  left?: boolean;
  /**
   * Canceled while its resumable create call was out. The create isn't cut off, because the id it
   * brings back is what stops the call at the company.
   */
  canceled?: boolean;
  /** A Batch run's create call, or a lookup of it, is out (set by the batch watcher). */
  calling?: boolean;
}

/** A canceled resumable call still to be stopped at the company, once the company can be reached. */
interface OwedCancel {
  jobSetId: string;
  providerId: string;
  modelKey: string;
  jobIds: string[];
  handle: JobHandle;
  /** Not before this, after a cancel that didn't get through. */
  after: number;
}

type Planned = Omit<Unit, "abort" | "id">;

/** What a stop waits for, told once as it starts (§0.12). */
export interface DrainNotice {
  /** Images waited for until they're done: calls that can't pick up where they left off. */
  finishing: number;
  /** Images whose create call is waited for only until the company's id is stored (Batch, resumable). */
  confirming: number;
  /** Canceled images whose cancel is on its way to the company. */
  stopping: number;
  /** The companies behind `confirming` and `stopping`, by name. */
  companies: string[];
}

export interface StopOptions {
  /** Longest wait for calls that can't resume. Default: none, each call's own timeout ends it (§0.12). */
  drainMs?: number;
  onDrain?: (notice: DrainNotice) => void;
}

export interface StopReport {
  /**
   * Images left running at the company, which the next start picks up where they left off: by id,
   * by the same create sent again with the same key, or from a Batch run's row.
   */
  left: number;
  /** Images cut off before they were done, by what the next start does with them (§0.4). */
  cut: { rerun: number; interrupted: number };
}

export interface RunnerDeps {
  db: Db;
  models: ModelService;
  credentials: CredentialService;
  settings: SettingsService;
  providerSettings: ProviderSettingsService;
  events: EventHub;
  ingest: Ingest;
  thumbs: Thumbs;
  contexts: CallContexts;
  logger: Logger;
  jobLog: (entry: Record<string, unknown>) => void;
  /** Prices a company answers per request (§6.9). Without it those runs are priced as unknown. */
  prices?: RemotePrices;
  /** OPENFIELD_FAKE_PROVIDERS=1: costs are recorded as 0 and never count toward spend (§0.13). */
  fake?: boolean;
  options?: Partial<QueueOptions>;
}

export class Runner {
  readonly opts: QueueOptions;
  readonly outcomes: Outcomes;
  readonly batches: BatchWatcher;
  readonly #units = new Map<string, Unit>();
  readonly #unitOfJob = new Map<string, Unit>();
  /** A waiting batch's poll, cancel and cleanup calls in flight, per company: each holds a slot (§0.12). */
  readonly #batchCalls = new Map<string, number>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #positions = new Map<string, number>();
  /** Flex busy answers in a row, per job. They don't count as attempts (§0.4). */
  readonly #busy = new Map<string, number>();
  /** Runs already tried again since this server started. */
  readonly #retried = new Set<string>();
  /** Resumable jobs nothing could follow just now (company off mid-run, a failed loop), and when to look again. */
  readonly #reattachAfter = new Map<string, number>();
  /** Jobs left running at the company by this stop. */
  readonly #left = new Set<string>();
  /** Canceled resumable calls to stop at the company, by handle, and the ones being sent now. */
  readonly #owed = new Map<string, OwedCancel>();
  readonly #sendingOwed = new Set<string>();
  /** Cancels on their way to the company, for the stop's notice. */
  readonly #cancelsOut = new Set<{ providerId: string; images: number }>();
  readonly #forced: Promise<false>;
  #force: () => void = () => {};
  #stopped: Promise<StopReport> | undefined;
  #rotation = 0;
  #tickQueued = false;
  #started = false;
  #stopping = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RunnerDeps) {
    this.#forced = new Promise<false>((resolve) => {
      this.#force = () => resolve(false);
    });
    this.opts = { ...QUEUE_DEFAULTS, ...deps.options };
    const fake = deps.fake ?? false;
    this.outcomes = new Outcomes({ ...deps, fake });
    this.batches = new BatchWatcher({
      ...deps,
      outcomes: this.outcomes,
      options: this.opts,
      fake,
      slots: (providerId, modelKey) => this.#takeBatchSlot(providerId, modelKey),
    });
  }

  /** Nothing is sent before this: the server calls it once it has its port (§8.4.5). */
  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    // Cancels that hadn't reached the company when Openfield last stopped go once it can be reached.
    for (const { job, jobSet } of canceledWithHandle(this.deps.db)) this.#owe(jobSet, job);
    this.batches.start();
    this.#heartbeat = setInterval(() => this.tick(), this.opts.heartbeatMs);
    this.#heartbeat.unref?.();
    this.tick();
  }

  /** Provider calls in flight right now. */
  get inFlight(): number {
    return this.#units.size;
  }

  // Creating job sets

  /**
   * POST /api/generate and /api/edit, and each job set of a canvas run. Returns before any
   * provider call (§8.3.1).
   */
  async createJobSet(
    body: GenerateRequest,
    opts: { priority?: number; canvasRunId?: string; agent?: string | null } = {},
  ): Promise<JobSetAccepted> {
    const existing = getJobSetByIdempotencyKey(this.deps.db, body.idempotencyKey);
    if (existing) return this.#accepted(existing.id);

    const { manifest, result } = await this.#prepare(body);
    for (const d of result.diagnostics) this.deps.logger.debug("Adjusted a setting for this model", d);
    for (const note of result.settings.notes)
      this.deps.logger.debug("A company setting doesn't apply here", note);
    const cost = await this.#askPrice(manifest, result.request);
    return this.#insert(manifest, result.request, result.jobIds, result.calls, {
      op: body.op,
      priority: opts.priority ?? 10,
      canvasRunId: opts.canvasRunId ?? null,
      agent: opts.agent ?? null,
      ...(cost && { cost }),
    });
  }

  /**
   * What createJobSet would charge, from the same checks and the same frozen request, without
   * making anything. Agents price a run with it before they're allowed to start one.
   */
  async quote(body: GenerateRequest): Promise<{ estimate: CostEstimate; request: NormalizedRequest }> {
    const { manifest, result } = await this.#prepare(body);
    const asked = await this.#askPrice(manifest, result.request);
    return { estimate: asked ?? this.#estimate(manifest, result.request), request: result.request };
  }

  /** The model, company and settings checks, then normalize (§0.3). Throws what the caller shows. */
  async #prepare(body: GenerateRequest) {
    const manifest = this.deps.models.get(body.model);
    if (!manifest)
      throw new ApiFailure(400, "bad_request", `Unknown model ${body.model}`, { field: "model" });
    this.#requireEnabled(manifest.providerId);
    // The company's settings are resolved for this model and frozen onto the run (§0.3).
    const result = await normalize(manifest, body, {
      jobSetId: newId(),
      settings: this.deps.providerSettings.forRun(manifest.providerId),
    });
    if (result.error) {
      throw new ApiFailure(400, result.error.code, result.error.userMessage, {
        field: result.error.field,
        userMessage: result.error.userMessage,
      });
    }
    return { manifest, result };
  }

  /**
   * A model priced per request is priced now, as it's sent, so the run and Spending carry what the
   * company said (§6.9). The answer is usually kept from the composer's ask; a slow one isn't
   * waited for past a few seconds, and the run is then priced as unknown.
   */
  async #askPrice(manifest: ModelManifest, request: NormalizedRequest): Promise<CostEstimate | undefined> {
    const prices = this.deps.prices;
    if (!prices || !asksForPrice(manifest)) return undefined;
    const late = sleep(PRICE_WAIT_MS).then(() => null);
    return (await Promise.race([prices.estimate(manifest, request), late])) ?? undefined;
  }

  /** Recreate (§0.1): replays the frozen request as a new job set, never the current UI state. */
  recreate(jobSetId: string, opts: { agent?: string | null } = {}): JobSetAccepted {
    const set = this.#jobSet(jobSetId);
    return this.#replay(set, { batch: set.requestJson.batch, source: "recreate", agent: opts.agent ?? null });
  }

  /**
   * POST /api/job-sets/:id/retry: the same frozen request again, optionally only the failures.
   * Once per run: a double click, or a second failed tile of the same run, must not bill twice.
   */
  retry(jobSetId: string, onlyFailed = false): JobSetAccepted {
    if (this.#retried.has(jobSetId)) {
      throw new ApiFailure(409, "conflict", "This run was already tried again", { field: "id" });
    }
    const set = this.#jobSet(jobSetId);
    const failed = jobsOf(this.deps.db, jobSetId).filter((j) =>
      (["failed", "interrupted", "canceled"] as JobState[]).includes(j.status),
    ).length;
    const batch = onlyFailed ? failed : set.requestJson.batch;
    if (batch === 0) throw new ApiFailure(409, "conflict", "Nothing in this run failed");
    const accepted = this.#replay(set, { batch, source: set.requestJson.source });
    this.#retried.add(jobSetId);
    return accepted;
  }

  #replay(
    set: JobSetRow,
    change: { batch: number; source: NormalizedRequest["source"]; agent?: string | null },
  ): JobSetAccepted {
    const manifest = this.deps.models.get(`${set.providerId}:${set.modelId}`);
    if (!manifest)
      throw new ApiFailure(400, "capability_unsupported", "This model isn't available anymore", {
        field: "model",
      });
    this.#requireEnabled(manifest.providerId);
    const jobIds = Array.from({ length: change.batch }, () => newId());
    // The frozen speed replays, unless the model stopped offering it.
    const speed = resolveSpeed(manifest, set.requestJson.speed, pricedOp(set.op)).speed;
    const request: NormalizedRequest = {
      ...set.requestJson,
      idempotencyKey: newId(),
      jobSetId: newId(),
      jobId: jobIds[0]!,
      batchIndex: 0,
      batch: change.batch,
      source: change.source,
      speed,
    };
    // The same request costs what it did: a model priced per request keeps the run's own price.
    const each = asksForPrice(manifest) ? eachFromSet(set) : undefined;
    return this.#insert(manifest, request, jobIds, planCalls(manifest, request, jobIds), {
      op: set.op,
      priority: set.priority,
      promptOriginal: set.promptOriginal,
      agent: change.agent ?? null,
      ...(each && { cost: scaleCost(each, change.batch) }),
    });
  }

  /** The local estimate, with the images the request sends in priced at their own sizes. */
  #estimate(manifest: ModelManifest, request: NormalizedRequest): CostEstimate {
    const ids = [
      ...(request.base ? [request.base.assetId] : []),
      ...(request.references ?? []).map((r) => r.assetId),
    ];
    const sizes = new Map(
      getAssets(this.deps.db, ids).map((a) => [a.id, { width: a.width, height: a.height }]),
    );
    const known = ids.flatMap((id) => sizes.get(id) ?? []);
    return estimate(manifest, { ...request, ...(known.length === ids.length && { inputImageSizes: known }) });
  }

  #insert(
    manifest: ModelManifest,
    request: NormalizedRequest,
    jobIds: string[],
    calls: NormalizedRequest[],
    meta: {
      op: Op;
      priority: number;
      promptOriginal?: string | null;
      canvasRunId?: string | null;
      agent?: string | null;
      /** A price the company answered for this request, for a model priced per request. */
      cost?: CostEstimate;
    },
  ): JobSetAccepted {
    const { providerId, modelId } = parseModelKey(request.model);
    // Priced at the speed this run resolved to (§0.13).
    const cost = meta.cost ?? this.#estimate(manifest, request);
    const jobCount = jobIds.length;
    const created = createJobSet(this.deps.db, {
      jobSet: {
        id: request.jobSetId,
        idempotencyKey: request.idempotencyKey,
        op: meta.op,
        providerId,
        modelId,
        prompt: request.promptAfterPreset,
        promptOriginal: meta.promptOriginal ?? null,
        negativePrompt: request.negativePrompt ?? null,
        requestJson: request,
        batchSize: jobCount,
        priority: meta.priority,
        source: request.source,
        canvasId: request.canvas?.canvasId ?? null,
        canvasNodeId: request.canvas?.nodeId ?? null,
        canvasRunId: meta.canvasRunId ?? null,
        costEstimateUsd: cost.confidence === "unknown" ? null : cost.max,
        speed: request.speed,
        agent: meta.agent ?? null,
      },
      jobs: jobIds.map((id, idx) => ({ id, idx, seed: seedFor(request, calls, idx) })),
    });
    const accepted = toJobSetWithJobs(created);
    if (created.created) {
      this.deps.events.publish("job_set.created", accepted);
      this.deps.jobLog({
        event: "job_set.created",
        jobSetId: created.jobSet.id,
        model: request.model,
        batch: jobCount,
        speed: request.speed,
      });
      this.tick();
    }
    return accepted;
  }

  /** A company turned off in Settings makes no calls at all (§0.6). */
  #requireEnabled(providerId: string): void {
    if (getProvider(this.deps.db, providerId)?.enabled !== false) return;
    const company = this.deps.credentials.provider(providerId).meta.displayName;
    throw new ApiFailure(400, "capability_unsupported", `${providerId} is turned off`, {
      field: "model",
      userMessage: t("errors.companyOff", { company }),
    });
  }

  #accepted(jobSetId: string): JobSetAccepted {
    const set = this.#jobSet(jobSetId);
    return toJobSetWithJobs({ jobSet: set, jobs: jobsOf(this.deps.db, jobSetId) });
  }

  #jobSet(id: string): JobSetRow {
    const set = getJobSet(this.deps.db, id);
    if (!set) throw new ApiFailure(404, "not_found", "That run doesn't exist", { field: "id" });
    return set;
  }

  // Scheduling

  /** Looks for work soon. Cheap to call often: ticks in the same task are coalesced. */
  tick(): void {
    if (!this.#started || this.#stopping || this.#tickQueued) return;
    this.#tickQueued = true;
    queueMicrotask(() => {
      this.#tickQueued = false;
      if (!this.#stopping) this.#schedule();
    });
  }

  /**
   * Priority DESC, created_at, idx, with round-robin across providers so a provider at its cap
   * can't hold up another one (§0.12). Caps: settings.globalConcurrency overall, and
   * min(providers.concurrency_cap, limits.maxConcurrent) per provider.
   */
  #schedule(): void {
    const now = new Date().toISOString();
    let free = this.deps.settings.get().globalConcurrency - this.#units.size - this.#batchCallCount();
    const rows = listProviders(this.deps.db);
    const caps = new Map(rows.map((p) => [p.id, p.concurrencyCap]));
    // Runs for a company that was turned off wait, and go ahead if it's turned back on.
    const off = new Set(rows.filter((p) => !p.enabled).map((p) => p.id));
    const busy = new Map(this.#batchCalls);
    for (const unit of this.#units.values()) busy.set(unit.providerId, (busy.get(unit.providerId) ?? 0) + 1);

    const queues = new Map<string, Planned[]>();
    const grouped = new Map<string, Planned>();
    const reattach = new Map<string, Planned>();
    const waiting: JobRow[] = [];
    for (const { job, jobSet } of activeJobs(this.deps.db)) {
      if (this.#unitOfJob.has(job.id)) continue;
      if (job.status !== "pending") {
        this.#toReattach(job, jobSet, off, reattach);
        continue;
      }
      if (job.nextAttemptAt && job.nextAttemptAt > now) continue;
      if (off.has(jobSet.providerId)) continue;
      waiting.push(job);
      const modelKey = `${jobSet.providerId}:${jobSet.modelId}`;
      // A Batch run goes as one provider batch, whatever its image count (§0.4).
      const kind = jobSet.speed === "batch" ? "batch" : "call";
      const whole = kind === "batch" || (this.deps.models.get(modelKey)?.capabilities.batch.native ?? false);
      if (whole && grouped.has(jobSet.id)) {
        grouped.get(jobSet.id)!.jobIds.push(job.id);
        continue;
      }
      const unit: Planned = {
        kind,
        jobSetId: jobSet.id,
        providerId: jobSet.providerId,
        modelKey,
        jobIds: [job.id],
      };
      if (whole) grouped.set(jobSet.id, unit);
      const queue = queues.get(jobSet.providerId) ?? [];
      queue.push(unit);
      queues.set(jobSet.providerId, queue);
    }

    this.#sendOwed(off);

    // Already running at the company, so they take their slots first, even past a cap lowered while
    // the server was down (§0.12).
    for (const unit of reattach.values()) {
      this.#launch(unit);
      busy.set(unit.providerId, (busy.get(unit.providerId) ?? 0) + 1);
      free--;
    }

    const providers = [...queues.keys()];
    const offset = providers.length ? this.#rotation++ % providers.length : 0;
    const order = [...providers.slice(offset), ...providers.slice(0, offset)];
    let started = true;
    while (free > 0 && started) {
      started = false;
      for (const providerId of order) {
        const queue = queues.get(providerId)!;
        const next = queue[0];
        if (!next || free <= 0) continue;
        const maxConcurrent = this.deps.models.get(next.modelKey)?.capabilities.limits.maxConcurrent ?? 1;
        const cap = Math.min(caps.get(providerId) ?? 1, maxConcurrent);
        if ((busy.get(providerId) ?? 0) >= cap) continue;
        queue.shift();
        this.#launch(next);
        busy.set(providerId, (busy.get(providerId) ?? 0) + 1);
        free--;
        started = true;
      }
    }

    // Tell each run still waiting how many are ahead of it, when that changes.
    const stillWaiting = waiting.filter((job) => !this.#unitOfJob.has(job.id));
    stillWaiting.forEach((job, i) => {
      if (this.#positions.get(job.id) === i + 1) return;
      this.#positions.set(job.id, i + 1);
      this.deps.events.publish("job.queued", {
        jobSetId: job.jobSetId,
        jobId: job.id,
        idx: job.idx,
        position: i + 1,
      });
    });
  }

  /**
   * A resumable call with a stored handle that nothing is following: after a restart, or after its
   * company was off. Jobs that share one handle (a native batch) go as one unit.
   */
  #toReattach(job: JobRow, jobSet: JobSetRow, off: ReadonlySet<string>, into: Map<string, Planned>): void {
    if (jobSet.speed === "batch" || !job.resumable || !job.handle || !IN_FLIGHT.includes(job.status)) return;
    const after = this.#reattachAfter.get(job.id);
    if (after !== undefined && after > Date.now()) return;
    // A company that's off or has no key leaves it waiting, like a queued run (§8.4.5).
    if (this.#waitsForCompany(jobSet.providerId, off)) return;
    this.#reattachAfter.delete(job.id);
    const key = `${jobSet.id}:${job.handle.providerRef ?? job.handle.jobId}`;
    const known = into.get(key);
    if (known) {
      known.jobIds.push(job.id);
      return;
    }
    into.set(key, {
      kind: "call",
      jobSetId: jobSet.id,
      providerId: jobSet.providerId,
      modelKey: `${jobSet.providerId}:${jobSet.modelId}`,
      jobIds: [job.id],
      reattach: job.handle,
    });
  }

  /** Turned off, or no key right now. A company this build doesn't know goes ahead and fails to bind. */
  #waitsForCompany(providerId: string, off: ReadonlySet<string>): boolean {
    if (off.has(providerId)) return true;
    try {
      return !this.deps.credentials.resolve(providerId).present;
    } catch {
      return false;
    }
  }

  #batchCallCount(): number {
    let total = 0;
    for (const n of this.#batchCalls.values()) total += n;
    return total;
  }

  /**
   * A slot for one call about a waiting batch, under the same caps as any run, or undefined when
   * they're all taken. The caller frees it with the function it gets back.
   */
  #takeBatchSlot(providerId: string, modelKey: string): (() => void) | undefined {
    const global = this.deps.settings.get().globalConcurrency;
    if (this.#units.size + this.#batchCallCount() >= global) return undefined;
    const maxConcurrent = this.deps.models.get(modelKey)?.capabilities.limits.maxConcurrent ?? 1;
    const cap = Math.min(getProvider(this.deps.db, providerId)?.concurrencyCap ?? 1, maxConcurrent);
    let busy = this.#batchCalls.get(providerId) ?? 0;
    for (const unit of this.#units.values()) if (unit.providerId === providerId) busy++;
    if (busy >= cap) return undefined;
    this.#batchCalls.set(providerId, (this.#batchCalls.get(providerId) ?? 0) + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.#batchCalls.set(providerId, Math.max(0, (this.#batchCalls.get(providerId) ?? 1) - 1));
      this.tick();
    };
  }

  #launch(planned: Planned): void {
    const unit: Unit = { ...planned, id: planned.jobIds[0]!, abort: new AbortController() };
    this.#units.set(unit.id, unit);
    for (const jobId of unit.jobIds) {
      this.#unitOfJob.set(jobId, unit);
      this.#positions.delete(jobId);
    }
    const work =
      unit.kind === "batch"
        ? this.batches.submit(unit)
        : unit.reattach
          ? this.#reattach(unit)
          : this.#run(unit);
    const task = work
      .catch((err) =>
        this.deps.logger.error("A run stopped unexpectedly", { jobSetId: unit.jobSetId, error: err }),
      )
      .finally(() => {
        this.#units.delete(unit.id);
        for (const jobId of planned.jobIds) this.#unitOfJob.delete(jobId);
        this.#tasks.delete(task);
        if (unit.resumable && unit.handle && !this.#stopping) this.#pauseFollowing(unit);
        this.tick();
      });
    this.#tasks.add(task);
  }

  /**
   * A resumable call stopped being followed before it ended (its company was turned off, or the loop
   * failed): the scheduler picks it up by id again after a pause, instead of at once in a loop.
   */
  #pauseFollowing(unit: Unit): void {
    const at = Date.now() + this.opts.poll.capMs;
    for (const jobId of unit.jobIds) {
      const job = getJob(this.deps.db, jobId);
      if (job && IN_FLIGHT.includes(job.status)) this.#reattachAfter.set(jobId, at);
    }
  }

  /** A cancel sent to the company: work stop() waits for that isn't a unit. */
  #trackCancel(work: Promise<void>, about: { providerId: string; images: number }): void {
    this.#cancelsOut.add(about);
    const task = work.finally(() => {
      this.#tasks.delete(task);
      this.#cancelsOut.delete(about);
    });
    this.#tasks.add(task);
  }

  // One provider call

  async #run(unit: Unit): Promise<void> {
    const { db } = this.deps;
    const set = getJobSet(db, unit.jobSetId);
    if (!set) return;
    // Written as the call goes out, so a restart knows whether it can pick the call up by id (§6.7).
    const listed = this.deps.models.get(unit.modelKey);
    unit.resumable = listed ? resumesAfterRestart(listed, set.requestJson.speed) : false;

    const started: JobRow[] = [];
    for (const jobId of unit.jobIds) {
      const job = getJob(db, jobId);
      if (!job) continue;
      const moved = transitionJob(
        db,
        jobId,
        "submitting",
        {
          attempt: job.attempt + 1,
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null,
          errorReason: null,
          errorAction: null,
          resumable: unit.resumable,
        },
        { from: ["pending"] },
      );
      if (moved) started.push(moved);
    }
    unit.jobIds = started.map((j) => j.id);
    if (started.length === 0) return;
    refreshJobSetStatus(db, set.id);
    for (const job of started) {
      const rerun = job.rerunAt !== null;
      this.deps.events.publish("job.started", {
        jobSetId: set.id,
        jobId: job.id,
        idx: job.idx,
        startedAt: job.startedAt ?? new Date().toISOString(),
        ...(rerun && { rerun: true as const }),
      });
      this.deps.jobLog({
        event: "job.started",
        jobId: job.id,
        jobSetId: set.id,
        attempt: job.attempt,
        ...(rerun && { rerun }),
      });
    }

    let bound: BoundModel;
    try {
      bound = this.deps.models.bind(unit.modelKey);
    } catch {
      const error = new ProviderError("capability_unsupported", {
        message: `${unit.modelKey} isn't available`,
      });
      return this.#fail(unit, set, error);
    }
    unit.bound = bound;
    const call = this.#callFor(set, bound.manifest, started);
    unit.call = call;
    // Frozen at submit (§0.3): settings changed since apply to new runs only.
    const speed = call.speed;
    const { attemptMs, deadlineMs } = runTimeouts(this.opts, bound.manifest, speed);

    const deadlineLeft = deadlineMs - (Date.now() - firstStart(started));
    if (deadlineLeft <= 0) {
      // Waiting out Flex busy answers until now ends with the busy reason, not a plain timeout.
      const error = unit.jobIds.some((id) => this.#busy.has(id))
        ? new ProviderError("provider_unavailable", {
            busy: true,
            message: "Flex was still busy at the deadline",
          })
        : new ProviderError("timeout", { message: "The run passed its deadline" });
      return this.#fail(unit, set, error);
    }

    const signal = AbortSignal.any([
      unit.abort.signal,
      AbortSignal.timeout(Math.min(attemptMs, deadlineLeft)),
    ]);
    const sink = this.deps.ingest.sink();
    const ctx = this.deps.contexts.for(bound.provider, signal, sink, {
      settings: call.providerSettings,
      speed,
    });
    if (!ctx) return this.#fail(unit, set, new ProviderError("auth_missing", { message: "No key is set" }));

    const t0 = Date.now();
    let handle: JobHandle;
    try {
      handle = await untilAborted(() => bound.model.submit(call, ctx), signal);
    } catch (err) {
      if (unit.abort.signal.aborted || unit.canceled) return sink.discardAll();
      const error = asProviderError(err, signal);
      // A resumable create that failed on the way (the network, a timeout, a 500) may still have
      // reached the company, which then makes and bills the image. Sending it again could start a
      // second one, unless the company honours the idempotency key and hands the first one back. So
      // it ends here, with Try again, like a Batch create nothing could find (§0.4).
      if (unit.resumable && !bound.manifest.idempotentSubmit && mayHaveArrived(error)) {
        return this.#end(unit, set, error, sink, Date.now() - t0);
      }
      return this.#fail(unit, set, error, sink, Date.now() - t0);
    }
    unit.handle = handle;
    if (unit.abort.signal.aborted) return sink.discardAll();
    if (unit.canceled) {
      // Canceled while the create was out: now there's an id, stop it at the company (§0.12). The
      // id goes on the canceled jobs first, so a cancel that doesn't get through is still sent after
      // a restart.
      sink.discardAll();
      storeCanceledHandle(db, unit.jobIds, this.deps.logger.scrubKeys(handle));
      return this.#stopCanceled(unit);
    }
    if (unit.resumable) {
      // Before the first poll: from here on a restart picks the call up by this id (§6.7). The
      // adapter keeps keys out of it; scrubbing is the second guard, since it's saved as it is.
      storeJobHandle(db, unit.jobIds, this.deps.logger.scrubKeys(handle), "running");
      refreshJobSetStatus(db, set.id);
      return this.#follow(unit, set, bound, call, handle, sink, t0);
    }

    try {
      for (const jobId of unit.jobIds) {
        transitionJob(db, jobId, "running", handle.providerRef ? { providerJobId: handle.providerRef } : {}, {
          from: ["submitting", "queued"],
        });
      }
      refreshJobSetStatus(db, set.id);

      const update = await this.#watch(unit, bound, handle, ctx);
      if (unit.abort.signal.aborted) return sink.discardAll();
      if (update.state === "succeeded" && update.result) {
        return this.#succeed(unit, set, bound.manifest, call, update.result, sink, Date.now() - t0);
      }
      const error =
        update.error ??
        new ProviderError(update.state === "canceled" ? "canceled" : "provider_error", {
          message: `The run ended as ${update.state} without an image`,
        });
      return this.#fail(unit, set, error, sink, Date.now() - t0);
    } catch (err) {
      if (unit.abort.signal.aborted) return sink.discardAll();
      return this.#fail(unit, set, asProviderError(err, signal), sink, Date.now() - t0);
    }
  }

  /** Picks a resumable call up by its stored id (§6.7, §8.4.5). Nothing is sent again. */
  async #reattach(unit: Unit): Promise<void> {
    const { db } = this.deps;
    const set = getJobSet(db, unit.jobSetId);
    const handle = unit.reattach;
    if (!set || !handle) return;
    const jobs = unit.jobIds
      .map((id) => getJob(db, id))
      .filter((j): j is JobRow => j !== undefined && IN_FLIGHT.includes(j.status));
    if (jobs.length === 0) return;
    unit.jobIds = jobs.map((j) => j.id);
    unit.resumable = true;
    unit.handle = handle;

    let bound: BoundModel;
    try {
      bound = this.deps.models.bind(unit.modelKey);
    } catch {
      // Turned off since the scheduler looked: it waits at the company, and is picked up once it's on.
      if (getProvider(db, set.providerId)?.enabled === false) return;
      const error = new ProviderError("capability_unsupported", {
        message: `${unit.modelKey} isn't available`,
      });
      return this.#end(unit, set, error);
    }
    unit.bound = bound;
    const call = this.#callFor(set, bound.manifest, jobs);
    unit.call = call;
    this.deps.jobLog({ event: "job.reattached", jobSetId: set.id, jobIds: unit.jobIds });
    return this.#follow(unit, set, bound, call, handle, this.deps.ingest.sink(), firstStart(jobs));
  }

  /**
   * Reads a resumable call by its id until the company gives an answer that ends it (§6.7): the
   * image, a failure, a refusal, or "no such call". Nothing else ends it, because the company may
   * still hold the image: a read that fails (the network, a full disk, a rejected key, a garbled
   * answer) reads the same id again, and the call is never sent again. Past the deadline, a call the
   * company says is still running is stopped there as a timeout, and reads that keep failing give up
   * after MISSES_PAST_DEADLINE in a row on the slower batch schedule, as a Batch run does, without
   * stopping anything at the company. The first read happens whatever the deadline says, because a
   * finished image is likely billed. Stopping leaves the call to the company.
   */
  async #follow(
    unit: Unit,
    set: JobSetRow,
    bound: BoundModel,
    call: NormalizedRequest,
    handle: JobHandle,
    sink: AttemptSink,
    t0: number,
  ): Promise<void> {
    const { attemptMs, deadlineMs } = runTimeouts(this.opts, bound.manifest, call.speed);
    const jobs = unit.jobIds.map((id) => getJob(this.deps.db, id)).filter((j) => j !== undefined);
    const since = Math.min(t0, firstStart(jobs));
    const late = () => Date.now() - since >= deadlineMs;
    let misses = 0;
    for (let poll = 0; ; poll++) {
      if (this.#stopping) return this.#leave(unit, sink);
      const signal = AbortSignal.any([unit.abort.signal, AbortSignal.timeout(attemptMs)]);
      const ctx = this.deps.contexts.for(bound.provider, signal, sink, {
        settings: call.providerSettings,
        speed: call.speed,
      });
      // Turned off, or its key was removed: it waits at the company, like a queued run (§8.4.5).
      if (!ctx) return sink.discardAll();

      let update: JobUpdate | undefined;
      let failed: ProviderError | undefined;
      try {
        update = await untilAborted(() => bound.model.poll(handle, ctx), signal);
      } catch (err) {
        // Canceled, left for the next start, or cut off: the job's state is someone else's now.
        if (unit.abort.signal.aborted) return sink.discardAll();
        failed = asProviderError(err, signal);
      }

      if (failed) {
        const latencyMs = Date.now() - t0;
        // The company's own answer about this call: it's gone there, or it refused the image.
        if (failed.notFound) {
          return this.#end(unit, set, failed, sink, latencyMs, {
            reason: failed.userMessage ?? null,
            action: "try-again",
          });
        }
        // Or an answer that reading again won't change, such as an image from an undeclared host.
        if (failed.code === "content_refused" || failed.final) {
          return this.#end(unit, set, failed, sink, latencyMs);
        }
        // A key put right while the company still holds the image lands it (§0.4).
        if (failed.code === "auth_invalid") {
          recordKeyCheck(this.deps.db, set.providerId, { ok: false, code: failed.code });
        }
        // A full disk means the image is done and waiting at the company: it never times out here,
        // as on a Batch run, and lands once there's room.
        if (failed.code !== "disk_full" && ++misses >= MISSES_PAST_DEADLINE && late()) {
          return this.#unchecked(unit, set, failed, sink, latencyMs);
        }
        this.deps.logger.warn("Couldn't check on an image. Trying again soon", {
          jobSetId: set.id,
          code: failed.code,
        });
      } else if (update) {
        misses = 0;
        this.#progress(unit, update);
        if (update.state === "succeeded" && update.result) {
          return this.#succeed(unit, set, bound.manifest, call, update.result, sink, Date.now() - t0);
        }
        if (isTerminalState(update.state)) {
          const error =
            update.error ??
            new ProviderError(update.state === "canceled" ? "canceled" : "provider_error", {
              message: `The run ended as ${update.state} without an image`,
            });
          return this.#end(unit, set, error, sink, Date.now() - t0);
        }
        // The company says it's still at it, past the deadline: stop it there.
        if (late()) return this.#timeUp(unit, set, sink, Date.now() - t0);
      }
      const wait =
        failed && late()
          ? batchPollDelay(this.opts, Date.now() - since, this.deps.fake ?? false, failed.retryAfterMs)
          : pollDelay(this.opts, poll, failed ? failed.retryAfterMs : update?.nextPollAfterMs);
      try {
        await sleep(wait, unit.abort.signal);
      } catch {
        return sink.discardAll();
      }
    }
  }

  /** Stopping: the call keeps going at the company, and the next start picks it up by id. */
  #leave(unit: Unit, sink?: AttemptSink): void {
    sink?.discardAll();
    unit.left = true;
    for (const jobId of unit.jobIds) this.#left.add(jobId);
  }

  /**
   * Ends a resumable call's jobs for good. Never retried: once the company has the call, sending it
   * again could bill twice (§0.4). A retryable code offers Try again, as on a Batch image.
   */
  #end(
    unit: Unit,
    set: JobSetRow,
    error: ProviderError,
    sink?: AttemptSink,
    latencyMs?: number,
    opts: { reason?: string | null; action?: ErrorAction | null } = {},
  ): void {
    sink?.discardAll();
    this.outcomes.fail(set, unit.jobIds, error, {
      latencyMs,
      speed: unit.call?.speed ?? set.speed,
      reason: opts.reason === undefined ? finalReason(error) : opts.reason,
      action: opts.action === undefined ? batchAction(error) : opts.action,
    });
    if (error.code === "auth_invalid" || error.code === "auth_forbidden") {
      recordKeyCheck(this.deps.db, set.providerId, { ok: false, code: error.code });
    }
    this.outcomes.finishSet(set.id);
  }

  /**
   * Reads kept failing past the deadline. The call isn't stopped at the company, which never said it
   * was still running. When the company couldn't be reached, the tile says so in our words;
   * otherwise it gets the last failure's own copy.
   */
  #unchecked(unit: Unit, set: JobSetRow, last: ProviderError, sink: AttemptSink, latencyMs: number): void {
    if (!last.retryable && last.code !== "unknown") {
      this.#end(unit, set, last, sink, latencyMs);
      return;
    }
    const company = (unit.bound?.provider ?? this.deps.credentials.provider(set.providerId)).meta.displayName;
    const reason = t("errors.resumeUnchecked", { company });
    const error = new ProviderError("timeout", {
      message: `No answer about the image by its deadline: ${last.message}`,
      userMessage: reason,
    });
    this.#end(unit, set, error, sink, latencyMs, { reason, action: "try-again" });
  }

  /** The company says it's still running past its deadline: stopped there when the adapter can, then a timeout. */
  async #timeUp(unit: Unit, set: JobSetRow, sink: AttemptSink, latencyMs: number): Promise<void> {
    sink.discardAll();
    await this.#cancelAtCompany(unit);
    const error = new ProviderError("timeout", { message: "Still running at the company at the deadline" });
    this.#end(unit, set, error, undefined, latencyMs, { reason: null, action: "try-again" });
  }

  /**
   * Asks the company to stop a resumable call, when the adapter can. True once there's nothing left
   * to stop there: it stopped, it's gone, or the adapter has no cancel. False when it couldn't be
   * asked or didn't answer.
   */
  async #cancelAtCompany(target: {
    jobSetId: string;
    jobIds: readonly string[];
    handle?: JobHandle | undefined;
    bound?: BoundModel | undefined;
    call?: NormalizedRequest | undefined;
  }): Promise<boolean> {
    const { bound, handle, call } = target;
    if (!handle || !bound?.model.cancel) return true;
    const cancel = bound.model.cancel.bind(bound.model);
    const speed = call?.speed ?? "standard";
    const { attemptMs } = runTimeouts(this.opts, bound.manifest, speed);
    const ctx = this.deps.contexts.for(
      bound.provider,
      AbortSignal.timeout(attemptMs),
      noWrites((id) => this.deps.ingest.read(id)),
      { settings: call?.providerSettings ?? {}, speed },
    );
    if (!ctx) return false;
    try {
      await untilAborted(() => cancel(handle, ctx), ctx.signal);
      this.deps.jobLog({ event: "job.stopped_at_company", jobSetId: target.jobSetId, jobIds: target.jobIds });
      return true;
    } catch (err) {
      if (asProviderError(err).notFound) return true;
      this.deps.logger.warn("Couldn't stop an image at the company", {
        jobSetId: target.jobSetId,
        error: err,
      });
      return false;
    }
  }

  /**
   * A canceled resumable call, stopped at the company. One that doesn't get through is owed: sent
   * again once the company can be reached, and after a restart, because the job keeps its handle.
   */
  async #stopCanceled(unit: Unit): Promise<void> {
    if (!unit.resumable || !unit.handle) return;
    if (await this.#cancelAtCompany(unit)) return clearCanceledHandles(this.deps.db, unit.jobIds);
    const set = getJobSet(this.deps.db, unit.jobSetId);
    const job = getJob(this.deps.db, unit.jobIds[0]!);
    if (set && job) this.#owe(set, { ...job, handle: unit.handle }, Date.now() + this.#owedWait());
  }

  /**
   * Remembers a canceled resumable call to stop at the company, unless another job still wants what
   * it's making (a native batch shares one call).
   */
  #owe(set: JobSetRow, job: JobRow, after = 0): void {
    const handle = job.handle;
    if (!handle || !job.resumable) return;
    const ref = handle.providerRef ?? handle.jobId;
    const sharing = jobsOf(this.deps.db, set.id).filter(
      (j) => j.handle && (j.handle.providerRef ?? j.handle.jobId) === ref,
    );
    if (sharing.some((j) => !isTerminalState(j.status))) return;
    const key = `${set.id}:${ref}`;
    this.#owed.set(key, {
      jobSetId: set.id,
      providerId: set.providerId,
      modelKey: `${set.providerId}:${set.modelId}`,
      jobIds: sharing.length ? sharing.map((j) => j.id) : [job.id],
      handle,
      after,
    });
    this.tick();
  }

  /** After a cancel that didn't get through: the longest retry wait, so a company that's down isn't pestered. */
  #owedWait(): number {
    return retryDelay(this.opts, this.opts.retryDelaysMs.length);
  }

  /** Sends owed cancels whose company can be reached now. They take no slot: a cancel is quick. */
  #sendOwed(off: ReadonlySet<string>): void {
    const now = Date.now();
    for (const [key, owed] of this.#owed) {
      if (this.#sendingOwed.has(key) || owed.after > now || this.#waitsForCompany(owed.providerId, off))
        continue;
      const set = getJobSet(this.deps.db, owed.jobSetId);
      let bound: BoundModel;
      try {
        bound = this.deps.models.bind(owed.modelKey);
      } catch {
        continue;
      }
      this.#sendingOwed.add(key);
      const sent = this.#cancelAtCompany({ ...owed, bound, call: set?.requestJson }).then((ok) => {
        if (ok) {
          this.#owed.delete(key);
          clearCanceledHandles(this.deps.db, owed.jobIds);
        } else {
          owed.after = Date.now() + this.#owedWait();
        }
      });
      this.#trackCancel(
        sent.finally(() => this.#sendingOwed.delete(key)),
        { providerId: owed.providerId, images: owed.jobIds.length },
      );
    }
  }

  /** The request for this unit: one image per call on fan-out, or the whole batch (§6.5 step 5). */
  #callFor(set: JobSetRow, manifest: ModelManifest, jobs: JobRow[]): NormalizedRequest {
    const request = set.requestJson;
    const first = jobs[0]!;
    if (manifest.capabilities.batch.native || request.batch === 1) {
      return { ...request, jobId: first.id, batchIndex: first.idx, batch: jobs.length };
    }
    return callsFor(manifest, request, jobsOf(this.deps.db, set.id)).get(first.id)!;
  }

  /** Polls until done. The first check is immediate: a blocking adapter's handle already holds the result. */
  async #watch(unit: Unit, bound: BoundModel, handle: JobHandle, ctx: CallContext): Promise<JobUpdate> {
    for (let poll = 0; ; poll++) {
      const update = await untilAborted(() => bound.model.poll(handle, ctx), ctx.signal);
      this.#progress(unit, update);
      if (isTerminalState(update.state)) return update;
      await sleep(pollDelay(this.opts, poll, update.nextPollAfterMs), ctx.signal);
    }
  }

  #progress(unit: Unit, update: JobUpdate): void {
    if (update.progress === undefined) return;
    const progress = Math.min(1, Math.max(0, update.progress / 100));
    for (const jobId of unit.jobIds) {
      const job = updateJob(this.deps.db, jobId, { progress });
      if (job)
        this.deps.events.publish("job.progress", {
          jobSetId: unit.jobSetId,
          jobId,
          idx: job.idx,
          progress,
        });
    }
  }

  #succeed(
    unit: Unit,
    set: JobSetRow,
    manifest: ModelManifest,
    call: NormalizedRequest,
    result: JobResult,
    sink: AttemptSink,
    latencyMs: number,
  ): void {
    const { db } = this.deps;
    const images = result.images.filter((i) => !i.partial);
    // Cost follows the speed the company served: a Priority call served at Standard bills Standard.
    const speedUsed = result.speedUsed ?? call.speed;
    const cost = this.outcomes.cost(manifest, call, speedUsed, result, set);
    const jobs = unit.jobIds.map((id) => getJob(db, id)).filter((j): j is JobRow => j !== undefined);

    jobs.forEach((job, i) => {
      this.#busy.delete(job.id);
      const image = images.find((img) => img.index === job.idx) ?? images[i];
      const staged = image && sink.take(image.assetId);
      if (!image || !staged) {
        this.outcomes.fail(
          set,
          [job.id],
          new ProviderError("provider_error", { message: "The model sent no image for this slot" }),
          { latencyMs, speed: speedUsed },
        );
        return;
      }
      this.outcomes.succeed({
        set,
        job,
        call,
        image,
        staged,
        cost,
        speedUsed,
        latencyMs,
        usage: result.usage,
      });
    });

    // Anything the adapter wrote that no job claimed.
    sink.discardAll();
    recordKeyCheck(db, set.providerId, { ok: true });
    this.outcomes.finishSet(set.id);
  }

  /** A failed attempt: retry retryable codes with backoff, wait out Flex busy, fail the rest (§8.4.3). */
  #fail(unit: Unit, set: JobSetRow, error: ProviderError, sink?: AttemptSink, latencyMs?: number): void {
    sink?.discardAll();
    const speed = unit.call?.speed ?? set.speed;
    const deadlineMs = this.#deadlineFor(unit, speed);
    if (error.busy) {
      this.#waitOutBusy(unit, set, error, deadlineMs, latencyMs);
      return;
    }

    const retry: string[] = [];
    const final: string[] = [];
    for (const jobId of unit.jobIds) {
      const job = getJob(this.deps.db, jobId);
      if (!job || isTerminalState(job.status)) continue;
      const elapsed = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
      const canRetry = error.retryable && job.attempt < this.opts.maxAttempts && elapsed < deadlineMs;
      (canRetry ? retry : final).push(jobId);
    }

    for (const jobId of retry) {
      const job = getJob(this.deps.db, jobId)!;
      const delay = retryDelay(this.opts, job.attempt, error.retryAfterMs);
      const retryAt = new Date(Date.now() + delay).toISOString();
      const moved = transitionJob(
        this.deps.db,
        jobId,
        "pending",
        {
          nextAttemptAt: retryAt,
          errorCode: error.code,
          errorMessage: this.deps.logger.scrub(error.message),
        },
        { from: IN_FLIGHT },
      );
      if (!moved) continue;
      this.deps.jobLog({
        event: "job.retry",
        jobId,
        jobSetId: set.id,
        attempt: job.attempt,
        code: error.code,
        delay,
      });
      this.deps.events.publish("job.queued", { jobSetId: set.id, jobId, idx: job.idx, retryAt });
      setTimeout(() => this.tick(), delay + 5).unref?.();
    }

    if (final.length) {
      for (const jobId of final) this.#busy.delete(jobId);
      // Out of time after retries reads as a timeout, whatever the last attempt said.
      const code =
        error.retryable && error.code !== "timeout" && this.#pastDeadline(final, deadlineMs)
          ? "timeout"
          : error.code;
      const finalError = code === error.code ? error : new ProviderError(code, { message: error.message });
      this.outcomes.fail(set, final, finalError, { latencyMs, speed });
    }
    if (error.code === "auth_invalid" || error.code === "auth_forbidden") {
      recordKeyCheck(this.deps.db, set.providerId, { ok: false, code: error.code });
    }
    this.outcomes.finishSet(set.id);
  }

  /**
   * Flex was busy (§0.4): back to pending on the busy schedule, without spending an attempt, until
   * the Flex deadline. Past it, the run fails with our own final reason.
   */
  #waitOutBusy(
    unit: Unit,
    set: JobSetRow,
    error: ProviderError,
    deadlineMs: number,
    latencyMs?: number,
  ): void {
    const final: string[] = [];
    for (const jobId of unit.jobIds) {
      const job = getJob(this.deps.db, jobId);
      if (!job || isTerminalState(job.status)) continue;
      const count = (this.#busy.get(jobId) ?? 0) + 1;
      const delay = busyDelay(this.opts, count, error.retryAfterMs);
      const elapsed = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
      if (elapsed + delay >= deadlineMs) {
        final.push(jobId);
        continue;
      }
      const retryAt = new Date(Date.now() + delay).toISOString();
      const moved = transitionJob(
        this.deps.db,
        jobId,
        "pending",
        {
          attempt: Math.max(0, job.attempt - 1),
          nextAttemptAt: retryAt,
          errorCode: error.code,
          errorMessage: this.deps.logger.scrub(error.message),
        },
        { from: IN_FLIGHT },
      );
      if (!moved) continue;
      this.#busy.set(jobId, count);
      this.deps.jobLog({ event: "job.busy", jobId, jobSetId: set.id, busy: count, delay });
      this.deps.events.publish("job.queued", { jobSetId: set.id, jobId, idx: job.idx, retryAt, busy: true });
      setTimeout(() => this.tick(), delay + 5).unref?.();
    }

    if (final.length) {
      for (const jobId of final) this.#busy.delete(jobId);
      const speed = unit.call?.speed ?? set.speed;
      const provider = unit.bound?.provider ?? this.deps.credentials.provider(set.providerId);
      const reason = t("errors.speedStayedBusy", {
        speed: speedName(provider.settings, speed),
        company: provider.meta.displayName,
      });
      const stayedBusy = new ProviderError("provider_unavailable", {
        message: `Still busy at the deadline: ${error.message}`,
        userMessage: reason,
        ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
      });
      this.outcomes.fail(set, final, stayedBusy, { latencyMs, speed, reason, action: "try-again" });
    }
    // Also refreshes the set's status when the jobs only went back to waiting.
    this.outcomes.finishSet(set.id);
  }

  #deadlineFor(unit: Unit, speed: SpeedId): number {
    const manifest = unit.bound?.manifest ?? this.deps.models.get(unit.modelKey);
    return manifest ? runTimeouts(this.opts, manifest, speed).deadlineMs : this.opts.jobDeadlineMs;
  }

  #pastDeadline(jobIds: string[], deadlineMs: number): boolean {
    return jobIds.some((id) => {
      const job = getJob(this.deps.db, id);
      return job?.startedAt ? Date.now() - Date.parse(job.startedAt) >= deadlineMs : false;
    });
  }

  // Cancellation (§0.12)

  cancelJobSet(jobSetId: string): CancelResponse {
    const set = this.#jobSet(jobSetId);
    // A Batch run stops as a whole, at the company (§0.12).
    if (set.speed === "batch") return this.batches.cancel(set, (id) => this.#unitOfJob.has(id));
    const out: CancelResponse = { canceled: [], notCancelable: [] };
    for (const job of jobsOf(this.deps.db, jobSetId)) {
      (this.#cancelOne(set, job) ? out.canceled : out.notCancelable).push(job.id);
    }
    this.outcomes.finishSet(jobSetId);
    return out;
  }

  cancelJob(jobId: string): void {
    const job = getJob(this.deps.db, jobId);
    if (!job) throw new ApiFailure(404, "not_found", "That image doesn't exist", { field: "id" });
    const set = this.#jobSet(job.jobSetId);
    // One provider batch can't lose one request, so this cancels the whole run.
    if (set.speed === "batch") {
      this.batches.cancel(set, (id) => this.#unitOfJob.has(id));
      return;
    }
    this.#cancelOne(set, job);
    this.outcomes.finishSet(job.jobSetId);
  }

  #cancelOne(set: JobSetRow, job: JobRow): boolean {
    if (isTerminalState(job.status)) return false;
    const unit = this.#unitOfJob.get(job.id);
    this.#busy.delete(job.id);
    // A resumable call whose company is off or has no key right now is still at the company.
    const atCompany = job.resumable && job.handle !== null && IN_FLIGHT.includes(job.status);

    if (!unit && !atCompany) {
      // Not sent yet, so nothing was spent.
      const moved = this.outcomes.cancel(set, job.id, { discarded: false });
      if (!moved) return false;
      this.#positions.delete(job.id);
      return true;
    }

    // In flight. A blocking call can't be stopped at the company, and a resumable one may be stopped
    // too late, so either way the work may still be billed: record it at the full estimate, marked
    // discarded, and drop any late result.
    const manifest = unit?.bound?.manifest ?? this.deps.models.get(`${set.providerId}:${set.modelId}`);
    const call = unit?.call ?? set.requestJson;
    const each = manifest ? this.outcomes.cost(manifest, call, call.speed, undefined, set).each : undefined;
    const moved = this.outcomes.cancel(set, job.id, { discarded: true, each, speed: call.speed });
    if (!moved) return false;
    if (!unit) {
      // Nothing is following it (its company is off or has no key): stopped there once it can be.
      this.#owe(set, moved);
      return true;
    }

    // Abort the call once nothing it's making is still wanted, and stop it at the company if it can.
    const stillWanted = unit.jobIds.some((id) => {
      const other = getJob(this.deps.db, id);
      return other !== undefined && !isTerminalState(other.status);
    });
    if (!stillWanted) {
      if (unit.resumable && !unit.handle) {
        // Its create is still out, and the id it brings back is what stops it at the company.
        unit.canceled = true;
      } else {
        unit.abort.abort(new DOMException("Canceled", "AbortError"));
        this.#trackCancel(this.#stopCanceled(unit), {
          providerId: unit.providerId,
          images: unit.jobIds.length,
        });
      }
    }
    return true;
  }

  // Stopping (§0.12)

  /**
   * Nothing new starts. A call that can't resume is waited for until it ends or reaches its own
   * timeout, so its image is saved. A resumable call is left running at the company once its handle
   * is stored, for the next start to pick up. `drainMs` caps the wait (tests), and forceStop() ends
   * it at once: whatever it cuts off keeps its state and takes §0.4's restart paths at the next
   * start. Safe to call twice.
   */
  stop(opts: StopOptions = {}): Promise<StopReport> {
    this.#stopped ??= this.#drain(opts);
    return this.#stopped;
  }

  /** A second Ctrl-C: aborts every call now. */
  forceStop(): void {
    this.#force();
  }

  async #drain(opts: StopOptions): Promise<StopReport> {
    this.#stopping = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    // A waiting batch holds no call: a poll, cancel or cleanup in flight is redone at the next start.
    // A batch create request in flight is a unit here, waited for until its id is stored. One the
    // company refused, waiting to try again, stops waiting and is sent at the next start.
    const batches = this.batches.stop(0);
    for (const unit of this.#units.values()) {
      if (!unit.resumable || !unit.handle || unit.canceled) continue;
      this.#leave(unit);
      unit.abort.abort(new DOMException("Left for the next start", "AbortError"));
    }
    opts.onDrain?.(this.#drainNotice());

    const all = Promise.allSettled([...this.#tasks]);
    const cap = opts.drainMs === undefined ? [] : [sleep(opts.drainMs).then(() => false as const)];
    const drained = await Promise.race([all.then(() => true as const), this.#forced, ...cap]);
    const cut: Unit[] = [];
    if (!drained) {
      for (const unit of this.#units.values()) {
        if (unit.left) continue;
        cut.push(unit);
        unit.abort.abort(new DOMException("Stopped", "AbortError"));
      }
      await Promise.race([all, sleep(2_000)]);
    }
    await batches;
    // First: what it cuts off that picks up next time joins the images left.
    const paths = this.#restartPaths(cut);
    const report = { left: this.#left.size + this.batches.atCompany(), cut: paths };
    this.deps.jobLog({ event: "server.stopped", forced: !drained, ...report });
    return report;
  }

  /**
   * What the drain waits for. A Batch create and a resumable create are waited for only until the
   * company's id is stored, then left there, so they're "confirming", not "finishing". A resumable
   * create that was canceled meanwhile waits for its id to send the cancel.
   */
  #drainNotice(): DrainNotice {
    const notice: DrainNotice = { finishing: 0, confirming: 0, stopping: 0, companies: [] };
    const companies = new Set<string>();
    for (const unit of this.#units.values()) {
      if (unit.left) continue;
      const images = unit.jobIds.length;
      if (unit.kind === "call" && !unit.resumable) {
        notice.finishing += images;
        continue;
      }
      // A Batch create waiting to try again stops waiting at once.
      if (unit.kind === "batch" && !unit.calling) continue;
      if (unit.canceled) notice.stopping += images;
      else notice.confirming += images;
      companies.add(unit.providerId);
    }
    for (const cancel of this.#cancelsOut) {
      notice.stopping += cancel.images;
      companies.add(cancel.providerId);
    }
    notice.companies = [...companies].map((id) => this.#companyName(id));
    return notice;
  }

  #companyName(providerId: string): string {
    try {
      return this.deps.credentials.provider(providerId).meta.displayName;
    } catch {
      return providerId;
    }
  }

  /** What the next start does with each image a forced stop cut off (§8.4.5). */
  #restartPaths(cut: readonly Unit[]): StopReport["cut"] {
    const out = { rerun: 0, interrupted: 0 };
    const rerunInterrupted = this.deps.settings.get().rerunInterrupted;
    for (const unit of cut) {
      // A Batch run's create is looked up by name at the next start.
      if (unit.kind === "batch") continue;
      const idempotentSubmit = this.deps.models.get(unit.modelKey)?.idempotentSubmit === true;
      for (const jobId of unit.jobIds) {
        const job = getJob(this.deps.db, jobId);
        const path = job && restartPath(job, { rerunInterrupted, idempotentSubmit });
        if (path === "rerun") out.rerun++;
        else if (path === "interrupt") out.interrupted++;
        else if (path === "resume" || path === "resend") this.#left.add(jobId);
      }
    }
    return out;
  }
}

/**
 * A failed call the company may have taken anyway: one it plainly refused (429, 503, a Flex busy
 * answer) or rejected (a 4xx, which isn't retryable) left nothing there.
 */
const mayHaveArrived = (error: ProviderError) => error.retryable && !error.busy && !refused(error);

/** When the earliest of these jobs started, epoch ms. Now when none has. */
function firstStart(jobs: readonly Pick<JobRow, "startedAt">[]): number {
  const times = jobs.map((j) => (j.startedAt ? Date.parse(j.startedAt) : Date.now()));
  return times.length ? Math.min(...times) : Date.now();
}

function seedFor(request: NormalizedRequest, calls: NormalizedRequest[], idx: number): number | null {
  const call = calls.find((c) => c.batchIndex === idx);
  if (call?.seed !== undefined && calls.length > 1) return call.seed;
  return request.seed === undefined ? null : request.seed + idx;
}
