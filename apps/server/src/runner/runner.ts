import {
  type CancelResponse,
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
  createJobSet,
  type Db,
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
  transitionJob,
  updateJob,
} from "@openfield/db";
import { estimate, pricedOp, resolveSpeed } from "@openfield/providers/manifest";
import {
  type CallContext,
  errorFromFetchFailure,
  isProviderError,
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
import type { SettingsService } from "../services/settings";
import { BatchWatcher, untilAborted } from "./batches";
import { callsFor, Outcomes } from "./outcomes";
import type { CallContexts } from "./provider-fetch";
import {
  busyDelay,
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

const IN_FLIGHT: readonly JobState[] = ["submitting", "queued", "running"];

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
}

type Planned = Omit<Unit, "abort" | "id">;

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
  #rotation = 0;
  #tickQueued = false;
  #stopping = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RunnerDeps) {
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

  start(): void {
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

  /** POST /api/generate and /api/edit. Returns before any provider call (§8.3.1). */
  async createJobSet(body: GenerateRequest, opts: { priority?: number } = {}): Promise<JobSetAccepted> {
    const existing = getJobSetByIdempotencyKey(this.deps.db, body.idempotencyKey);
    if (existing) return this.#accepted(existing.id);

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
    for (const d of result.diagnostics) this.deps.logger.debug("Adjusted a setting for this model", d);
    for (const note of result.settings.notes)
      this.deps.logger.debug("A company setting doesn't apply here", note);
    return this.#insert(manifest, result.request, result.jobIds, result.calls, {
      op: body.op,
      priority: opts.priority ?? 10,
    });
  }

  /** Recreate (§0.1): replays the frozen request as a new job set, never the current UI state. */
  recreate(jobSetId: string): JobSetAccepted {
    const set = this.#jobSet(jobSetId);
    return this.#replay(set, { batch: set.requestJson.batch, source: "recreate" });
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

  #replay(set: JobSetRow, change: { batch: number; source: NormalizedRequest["source"] }): JobSetAccepted {
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
    return this.#insert(manifest, request, jobIds, planCalls(manifest, request, jobIds), {
      op: set.op,
      priority: set.priority,
      promptOriginal: set.promptOriginal,
    });
  }

  #insert(
    manifest: ModelManifest,
    request: NormalizedRequest,
    jobIds: string[],
    calls: NormalizedRequest[],
    meta: { op: Op; priority: number; promptOriginal?: string | null },
  ): JobSetAccepted {
    const { providerId, modelId } = parseModelKey(request.model);
    // Priced at the speed this run resolved to (§0.13).
    const cost = estimate(manifest, request);
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
        costEstimateUsd: cost.confidence === "unknown" ? null : cost.max,
        speed: request.speed,
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
    if (this.#stopping || this.#tickQueued) return;
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
    const waiting: JobRow[] = [];
    for (const { job, jobSet } of activeJobs(this.deps.db)) {
      if (job.status !== "pending" || this.#unitOfJob.has(job.id)) continue;
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
    const work = unit.kind === "batch" ? this.batches.submit(unit) : this.#run(unit);
    const task = work
      .catch((err) =>
        this.deps.logger.error("A run stopped unexpectedly", { jobSetId: unit.jobSetId, error: err }),
      )
      .finally(() => {
        this.#units.delete(unit.id);
        for (const jobId of planned.jobIds) this.#unitOfJob.delete(jobId);
        this.#tasks.delete(task);
        this.tick();
      });
    this.#tasks.add(task);
  }

  // One provider call

  async #run(unit: Unit): Promise<void> {
    const { db } = this.deps;
    const set = getJobSet(db, unit.jobSetId);
    if (!set) return;

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
        },
        { from: ["pending"] },
      );
      if (moved) started.push(moved);
    }
    unit.jobIds = started.map((j) => j.id);
    if (started.length === 0) return;
    refreshJobSetStatus(db, set.id);
    for (const job of started) {
      this.deps.events.publish("job.started", {
        jobSetId: set.id,
        jobId: job.id,
        idx: job.idx,
        startedAt: job.startedAt ?? new Date().toISOString(),
      });
      this.deps.jobLog({ event: "job.started", jobId: job.id, jobSetId: set.id, attempt: job.attempt });
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

    const firstStart = Math.min(...started.map((j) => Date.parse(j.startedAt ?? new Date().toISOString())));
    const deadlineLeft = deadlineMs - (Date.now() - firstStart);
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
    try {
      const handle = await untilAborted(bound.model.submit(call, ctx), signal);
      unit.handle = handle;
      if (unit.abort.signal.aborted) return sink.discardAll();
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
      const error = isProviderError(err)
        ? err
        : signal.aborted
          ? errorFromFetchFailure(err, signal)
          : new ProviderError("unknown", {
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            });
      return this.#fail(unit, set, error, sink, Date.now() - t0);
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
      const update = await untilAborted(bound.model.poll(handle, ctx), ctx.signal);
      if (update.progress !== undefined) {
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
      if (isTerminalState(update.state)) return update;
      await sleep(pollDelay(this.opts, poll, update.nextPollAfterMs), ctx.signal);
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
    const cost = this.outcomes.cost(manifest, call, speedUsed, result);
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

    if (!unit) {
      // Not sent yet, so nothing was spent.
      const moved = this.outcomes.cancel(set, job.id, { discarded: false });
      if (!moved) return false;
      this.#positions.delete(job.id);
      return true;
    }

    // In flight. Neither launch adapter can cancel a sync call on the provider's side, so the work
    // may still be billed: record it at the full estimate, marked discarded, and drop any late result.
    const manifest = unit.bound?.manifest ?? this.deps.models.get(unit.modelKey);
    const call = unit.call ?? set.requestJson;
    const each = manifest ? estimate(manifest, { ...call, batch: 1 }) : undefined;
    const moved = this.outcomes.cancel(set, job.id, { discarded: true, each, speed: call.speed });
    if (!moved) return false;

    // Abort the call once nothing it's making is still wanted.
    const stillWanted = unit.jobIds.some((id) => {
      const other = getJob(this.deps.db, id);
      return other !== undefined && !isTerminalState(other.status);
    });
    if (!stillWanted) unit.abort.abort(new DOMException("Canceled", "AbortError"));
    return true;
  }

  // Shutdown

  /**
   * Stops scheduling, gives in-flight calls `drainMs` to finish, then aborts the rest. Aborted
   * jobs keep their state, so the next boot marks them interrupted (§8.4.5). A Batch run keeps
   * waiting at the company and resumes from its row.
   */
  async stop(drainMs = 10_000): Promise<void> {
    this.#stopping = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const batches = this.batches.stop(drainMs);
    const all = Promise.allSettled([...this.#tasks]);
    const drained = await Promise.race([all.then(() => true), sleep(drainMs).then(() => false)]);
    if (!drained) {
      for (const unit of this.#units.values())
        unit.abort.abort(new DOMException("Shutting down", "AbortError"));
      await Promise.race([all, sleep(2_000)]);
    }
    await batches;
  }
}

function seedFor(request: NormalizedRequest, calls: NormalizedRequest[], idx: number): number | null {
  const call = calls.find((c) => c.batchIndex === idx);
  if (call?.seed !== undefined && calls.length > 1) return call.seed;
  return request.seed === undefined ? null : request.seed + idx;
}
