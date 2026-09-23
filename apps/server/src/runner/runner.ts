import {
  type CancelResponse,
  errorCopy,
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
  THUMB_RUNGS,
  t,
  type UsageUnits,
} from "@openfield/core";
import {
  activeJobs,
  assetsForJobSets,
  createJobSet,
  type Db,
  getAsset,
  getJob,
  getJobSet,
  getJobSetByIdempotencyKey,
  getProvider,
  insertAsset,
  insertAssetEdges,
  insertUsage,
  type JobRow,
  type JobSetRow,
  jobsOf,
  listProviders,
  recordKeyCheck,
  refreshJobSetStatus,
  transitionJob,
  updateJob,
  updateJobSet,
} from "@openfield/db";
import { estimate } from "@openfield/providers/manifest";
import {
  type CallContext,
  errorFromFetchFailure,
  isProviderError,
  type JobResult,
  type JobUpdate,
  normalize,
  ProviderError,
  type ProviderUsage,
  planCalls,
} from "@openfield/providers/server";
import type { EventHub } from "../events/hub";
import type { AttemptSink, Ingest } from "../files/ingest";
import { Thumbs } from "../files/thumbs";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import { toAssetListItem } from "../mappers/asset";
import { toJobSetWithJobs } from "../mappers/job";
import type { CredentialService } from "../services/credentials";
import type { BoundModel, ModelService } from "../services/models";
import type { SettingsService } from "../services/settings";
import type { CallContexts } from "./provider-fetch";
import { pollDelay, QUEUE_DEFAULTS, type QueueOptions, retryDelay, sleep } from "./timing";

// The job queue (§8.4, §0.12): an in-process scheduler with SQLite as its durable state.
// One unit is one provider call: a single job on fan-out, or every job of a set when the model
// takes a batch natively. Every state change goes through a guarded transition, so a late
// result can never overwrite a cancel.

const IN_FLIGHT: readonly JobState[] = ["submitting", "queued", "running"];

interface Unit {
  id: string;
  jobSetId: string;
  providerId: string;
  modelKey: string;
  jobIds: string[];
  abort: AbortController;
  bound?: BoundModel;
  call?: NormalizedRequest;
  handle?: JobHandle;
}

export interface RunnerDeps {
  db: Db;
  models: ModelService;
  credentials: CredentialService;
  settings: SettingsService;
  events: EventHub;
  ingest: Ingest;
  thumbs: Thumbs;
  contexts: CallContexts;
  logger: Logger;
  jobLog: (entry: Record<string, unknown>) => void;
  options?: Partial<QueueOptions>;
}

export class Runner {
  readonly opts: QueueOptions;
  readonly #units = new Map<string, Unit>();
  readonly #unitOfJob = new Map<string, Unit>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #positions = new Map<string, number>();
  /** Runs already tried again since this server started. */
  readonly #retried = new Set<string>();
  #rotation = 0;
  #tickQueued = false;
  #stopping = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RunnerDeps) {
    this.opts = { ...QUEUE_DEFAULTS, ...deps.options };
  }

  start(): void {
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
    const result = await normalize(manifest, body, { jobSetId: newId() });
    if (result.error) {
      throw new ApiFailure(400, result.error.code, result.error.userMessage, {
        field: result.error.field,
        userMessage: result.error.userMessage,
      });
    }
    for (const d of result.diagnostics) this.deps.logger.debug("Adjusted a setting for this model", d);
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
    const request: NormalizedRequest = {
      ...set.requestJson,
      idempotencyKey: newId(),
      jobSetId: newId(),
      jobId: jobIds[0]!,
      batchIndex: 0,
      batch: change.batch,
      source: change.source,
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
    let free = this.deps.settings.get().globalConcurrency - this.#units.size;
    const rows = listProviders(this.deps.db);
    const caps = new Map(rows.map((p) => [p.id, p.concurrencyCap]));
    // Runs for a company that was turned off wait, and go ahead if it's turned back on.
    const off = new Set(rows.filter((p) => !p.enabled).map((p) => p.id));
    const busy = new Map<string, number>();
    for (const unit of this.#units.values()) busy.set(unit.providerId, (busy.get(unit.providerId) ?? 0) + 1);

    const queues = new Map<string, Omit<Unit, "abort" | "id">[]>();
    const grouped = new Map<string, Omit<Unit, "abort" | "id">>();
    const waiting: JobRow[] = [];
    for (const { job, jobSet } of activeJobs(this.deps.db)) {
      if (job.status !== "pending" || this.#unitOfJob.has(job.id)) continue;
      if (job.nextAttemptAt && job.nextAttemptAt > now) continue;
      if (off.has(jobSet.providerId)) continue;
      waiting.push(job);
      const modelKey = `${jobSet.providerId}:${jobSet.modelId}`;
      const native = this.deps.models.get(modelKey)?.capabilities.batch.native ?? false;
      if (native && grouped.has(jobSet.id)) {
        grouped.get(jobSet.id)!.jobIds.push(job.id);
        continue;
      }
      const unit = { jobSetId: jobSet.id, providerId: jobSet.providerId, modelKey, jobIds: [job.id] };
      if (native) grouped.set(jobSet.id, unit);
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

  #launch(planned: Omit<Unit, "abort" | "id">): void {
    const unit: Unit = { ...planned, id: planned.jobIds[0]!, abort: new AbortController() };
    this.#units.set(unit.id, unit);
    for (const jobId of unit.jobIds) {
      this.#unitOfJob.set(jobId, unit);
      this.#positions.delete(jobId);
    }
    const task = this.#run(unit)
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

    const firstStart = Math.min(...started.map((j) => Date.parse(j.startedAt ?? new Date().toISOString())));
    const deadlineLeft = this.opts.jobDeadlineMs - (Date.now() - firstStart);
    if (deadlineLeft <= 0)
      return this.#fail(unit, set, new ProviderError("timeout", { message: "The run passed its deadline" }));

    const attemptMs = this.opts.attemptTimeoutMs ?? bound.manifest.capabilities.limits.requestTimeoutMs;
    const signal = AbortSignal.any([
      unit.abort.signal,
      AbortSignal.timeout(Math.min(attemptMs, deadlineLeft)),
    ]);
    const sink = this.deps.ingest.sink();
    const ctx = this.deps.contexts.for(bound.provider, signal, sink);
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
    const all = jobsOf(this.deps.db, set.id).map((j) => j.id);
    const planned = all.length === request.batch ? planCalls(manifest, request, all) : [];
    return (
      planned.find((c) => c.jobId === first.id) ?? {
        ...request,
        jobId: first.id,
        batchIndex: first.idx,
        batch: 1,
      }
    );
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
    const each = estimate(manifest, { ...call, batch: 1 });
    const rung = THUMB_RUNGS[this.deps.settings.get().feedZoom] ?? 456;
    const jobs = unit.jobIds.map((id) => getJob(db, id)).filter((j): j is JobRow => j !== undefined);

    jobs.forEach((job, i) => {
      const image = images.find((img) => img.index === job.idx) ?? images[i];
      const staged = image && sink.take(image.assetId);
      if (!image || !staged) {
        this.#failJobs(
          set,
          [job.id],
          new ProviderError("provider_error", { message: "The model sent no image for this slot" }),
          latencyMs,
        );
        return;
      }
      const costUsd = result.cost
        ? result.cost.amount / Math.max(1, images.length)
        : each.confidence === "unknown"
          ? null
          : each.max;
      const costSource = result.cost?.confidence ?? (each.confidence === "unknown" ? "unknown" : "estimated");
      const base = call.base?.assetId;

      const committed = db.transaction((tx) => {
        const moved = transitionJob(
          tx,
          job.id,
          "succeeded",
          { progress: 1, latencyMs, seed: image.seed ?? job.seed },
          { from: IN_FLIGHT },
        );
        // Canceled while the provider was working: keep nothing (§0.12).
        if (!moved) return undefined;
        const asset = insertAsset(tx, {
          id: staged.assetId,
          kind: set.op === "generate" || set.op === "variation" ? "generated" : "edited",
          jobId: job.id,
          jobSetId: set.id,
          path: staged.path,
          mime: staged.mime,
          width: staged.width,
          height: staged.height,
          bytes: staged.bytes,
          sha256: staged.sha256,
          seed: image.seed ?? job.seed,
          providerId: set.providerId,
          modelId: set.modelId,
          prompt: call.prompt,
          params: paramsOf(call),
          costUsd,
          parentAssetId: base ?? null,
          rootAssetId: base
            ? (getAsset(tx, base, { includeDeleted: true })?.rootAssetId ?? base)
            : staged.assetId,
          op: set.op,
          maskAssetId: call.mask?.assetId ?? null,
          generative: true,
        });
        insertAssetEdges(tx, [
          ...(base ? [{ parentAssetId: base, childAssetId: asset.id, relation: "derived" as const }] : []),
          ...(call.references ?? []).map((r, ordinal) => ({
            parentAssetId: r.assetId,
            childAssetId: asset.id,
            relation: "reference" as const,
            ordinal,
          })),
        ]);
        insertUsage(tx, {
          providerId: set.providerId,
          modelId: set.modelId,
          jobSetId: set.id,
          jobId: job.id,
          batchIndex: job.idx,
          operation: set.op,
          outcome: "succeeded",
          size: `${staged.width}x${staged.height}`,
          quality: call.quality ?? null,
          units: unitsOf(result.usage),
          estimateMin: each.min,
          estimateMax: each.max,
          costUsd,
          costSource,
          priceAsOf: each.pricedAt || null,
          latencyMs,
        });
        return asset;
      });

      if (!committed) {
        this.deps.ingest.discard(staged);
        return;
      }
      this.deps.events.publish("job.output", {
        jobSetId: set.id,
        jobId: job.id,
        idx: job.idx,
        asset: toAssetListItem(committed, false),
      });
      this.deps.jobLog({
        event: "job.succeeded",
        jobId: job.id,
        jobSetId: set.id,
        assetId: committed.id,
        latencyMs,
      });
      this.deps.thumbs.warm(committed, Thumbs.sizeFor({ h: rung }));
    });

    // Anything the adapter wrote that no job claimed.
    sink.discardAll();
    recordKeyCheck(db, set.providerId, { ok: true });
    this.#finishSet(set.id);
  }

  /** A failed attempt: retry retryable codes with backoff, fail the rest (§8.4.3). */
  #fail(unit: Unit, set: JobSetRow, error: ProviderError, sink?: AttemptSink, latencyMs?: number): void {
    sink?.discardAll();
    const retry: string[] = [];
    const final: string[] = [];
    for (const jobId of unit.jobIds) {
      const job = getJob(this.deps.db, jobId);
      if (!job || isTerminalState(job.status)) continue;
      const elapsed = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0;
      const canRetry =
        error.retryable && job.attempt < this.opts.maxAttempts && elapsed < this.opts.jobDeadlineMs;
      (canRetry ? retry : final).push(jobId);
    }

    for (const jobId of retry) {
      const job = getJob(this.deps.db, jobId)!;
      const delay = retryDelay(this.opts, job.attempt, error.retryAfterMs);
      const moved = transitionJob(
        this.deps.db,
        jobId,
        "pending",
        {
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
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
      this.deps.events.publish("job.queued", { jobSetId: set.id, jobId, idx: job.idx });
      setTimeout(() => this.tick(), delay + 5).unref?.();
    }

    if (final.length) {
      // Out of time after retries reads as a timeout, whatever the last attempt said.
      const code =
        error.retryable && error.code !== "timeout" && this.#pastDeadline(final) ? "timeout" : error.code;
      const finalError = code === error.code ? error : new ProviderError(code, { message: error.message });
      this.#failJobs(set, final, finalError, latencyMs);
    }
    if (error.code === "auth_invalid" || error.code === "auth_forbidden") {
      recordKeyCheck(this.deps.db, set.providerId, { ok: false, code: error.code });
    }
    this.#finishSet(set.id);
  }

  #pastDeadline(jobIds: string[]): boolean {
    return jobIds.some((id) => {
      const job = getJob(this.deps.db, id);
      return job?.startedAt ? Date.now() - Date.parse(job.startedAt) >= this.opts.jobDeadlineMs : false;
    });
  }

  /** Terminal failure. A failed job logs usage at no cost, never added to spend (§0.13). */
  #failJobs(set: JobSetRow, jobIds: string[], error: ProviderError, latencyMs?: number): void {
    const message = this.deps.logger.scrub(error.message);
    const reason = tileReason(error);
    for (const jobId of jobIds) {
      const moved = this.deps.db.transaction((tx) => {
        const job = transitionJob(tx, jobId, "failed", {
          errorCode: error.code,
          errorMessage: message,
          errorReason: reason,
        });
        if (!job) return undefined;
        insertUsage(tx, {
          providerId: set.providerId,
          modelId: set.modelId,
          jobSetId: set.id,
          jobId,
          batchIndex: job.idx,
          operation: set.op,
          outcome: "failed",
          costUsd: 0,
          costSource: "unknown",
          latencyMs: latencyMs ?? null,
          httpStatus: error.httpStatus ?? null,
        });
        return job;
      });
      if (!moved) continue;
      this.deps.jobLog({ event: "job.failed", jobId, jobSetId: set.id, code: error.code, message });
      this.deps.events.publish("job.failed", {
        jobSetId: set.id,
        jobId,
        idx: moved.idx,
        error: {
          code: error.code,
          message,
          ...(reason && { reason }),
          retryable: error.retryable,
          ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
          ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
          ...(error.providerCode !== undefined && { providerCode: error.providerCode }),
          ...(error.field !== undefined && { field: error.field }),
        },
      });
    }
  }

  /**
   * Recomputes a set's status and emits job_set.completed on the move to a terminal state.
   * The only place that makes that move, so the event fires exactly once.
   */
  #finishSet(jobSetId: string): void {
    const before = getJobSet(this.deps.db, jobSetId);
    if (!before || isTerminalState(before.status)) return;
    const after = refreshJobSetStatus(this.deps.db, jobSetId);
    if (!after || !isTerminalState(after.status)) return;

    const jobs = jobsOf(this.deps.db, jobSetId);
    const costs = assetsForJobSets(this.deps.db, [jobSetId]).map((a) => a.costUsd ?? 0);
    const firstFailure = jobs.find((j) => j.status === "failed");
    updateJobSet(this.deps.db, jobSetId, {
      costActualUsd: costs.length ? round(costs.reduce((a, b) => a + b, 0)) : null,
      errorCode: firstFailure?.errorCode ?? null,
      errorMessage: firstFailure?.errorMessage ?? null,
    });
    const done = getJobSet(this.deps.db, jobSetId)!;
    this.deps.events.publish("job_set.completed", {
      jobSetId,
      status: done.status,
      costActualUsd: done.costActualUsd,
      durationMs: Math.max(0, Date.parse(done.finishedAt ?? done.createdAt) - Date.parse(done.createdAt)),
    });
    this.deps.events.publish("usage.updated", { jobSetId });
    this.deps.jobLog({ event: "job_set.completed", jobSetId, status: done.status });
  }

  // Cancellation (§0.12)

  cancelJobSet(jobSetId: string): CancelResponse {
    const set = this.#jobSet(jobSetId);
    const out: CancelResponse = { canceled: [], notCancelable: [] };
    for (const job of jobsOf(this.deps.db, jobSetId)) {
      (this.#cancelOne(set, job) ? out.canceled : out.notCancelable).push(job.id);
    }
    this.#finishSet(jobSetId);
    return out;
  }

  cancelJob(jobId: string): void {
    const job = getJob(this.deps.db, jobId);
    if (!job) throw new ApiFailure(404, "not_found", "That image doesn't exist", { field: "id" });
    this.#cancelOne(this.#jobSet(job.jobSetId), job);
    this.#finishSet(job.jobSetId);
  }

  #cancelOne(set: JobSetRow, job: JobRow): boolean {
    if (isTerminalState(job.status)) return false;
    const unit = this.#unitOfJob.get(job.id);
    const idx = job.idx;

    if (!unit) {
      // Not sent yet, so nothing was spent.
      const moved = transitionJob(
        this.deps.db,
        job.id,
        "canceled",
        { errorCode: "canceled" },
        { from: ["pending", "queued"] },
      );
      if (!moved) return false;
      this.#positions.delete(job.id);
      this.deps.events.publish("job.canceled", { jobSetId: set.id, jobId: job.id, idx, discarded: false });
      this.deps.jobLog({ event: "job.canceled", jobId: job.id, jobSetId: set.id, discarded: false });
      return true;
    }

    // In flight. Neither launch adapter can cancel on the provider's side, so the work may still
    // be billed: record it at the full estimate, marked discarded, and drop any late result.
    const manifest = unit.bound?.manifest ?? this.deps.models.get(unit.modelKey);
    const each = manifest ? estimate(manifest, { ...(unit.call ?? set.requestJson), batch: 1 }) : undefined;
    const moved = this.deps.db.transaction((tx) => {
      const row = transitionJob(tx, job.id, "canceled", { errorCode: "canceled" });
      if (!row) return undefined;
      insertUsage(tx, {
        providerId: set.providerId,
        modelId: set.modelId,
        jobSetId: set.id,
        jobId: job.id,
        batchIndex: idx,
        operation: set.op,
        outcome: "canceled",
        estimateMin: each?.min ?? null,
        estimateMax: each?.max ?? null,
        costUsd: each && each.confidence !== "unknown" ? each.max : null,
        costSource: each && each.confidence !== "unknown" ? "estimated" : "unknown",
        priceAsOf: each?.pricedAt || null,
        discarded: true,
      });
      return row;
    });
    if (!moved) return false;
    this.deps.events.publish("job.canceled", { jobSetId: set.id, jobId: job.id, idx, discarded: true });
    this.deps.jobLog({ event: "job.canceled", jobId: job.id, jobSetId: set.id, discarded: true });

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
   * jobs keep their state, so the next boot marks them interrupted (§8.4.5).
   */
  async stop(drainMs = 10_000): Promise<void> {
    this.#stopping = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const all = Promise.allSettled([...this.#tasks]);
    const drained = await Promise.race([all.then(() => true), sleep(drainMs).then(() => false)]);
    if (drained) return;
    for (const unit of this.#units.values())
      unit.abort.abort(new DOMException("Shutting down", "AbortError"));
    await Promise.race([all, sleep(2_000)]);
  }
}

/**
 * The adapter's own copy for the tile, when it says more than the code's usual reason. A retryable
 * error only lands here once the retries ran out, so its "trying again" wording no longer holds.
 */
function tileReason(error: ProviderError): string | null {
  if (error.retryable || error.userMessage === errorCopy(error.code).reason) return null;
  return error.userMessage;
}

/** Stops waiting when the signal fires, even if an adapter ignores it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function seedFor(request: NormalizedRequest, calls: NormalizedRequest[], idx: number): number | null {
  const call = calls.find((c) => c.batchIndex === idx);
  if (call?.seed !== undefined && calls.length > 1) return call.seed;
  return request.seed === undefined ? null : request.seed + idx;
}

/** The settings that made an image, minus the ids that change on every run. */
function paramsOf(call: NormalizedRequest): Record<string, unknown> {
  const { jobId: _j, jobSetId: _s, batchIndex: _b, idempotencyKey: _k, ...params } = call;
  return params;
}

function unitsOf(usage?: ProviderUsage): UsageUnits | null {
  if (!usage) return null;
  const tokensIn = (usage.inputTextTokens ?? 0) + (usage.inputImageTokens ?? 0);
  return {
    ...(usage.imagesBilled !== undefined && { images: usage.imagesBilled }),
    ...(tokensIn > 0 && { tokensIn }),
    ...(usage.outputImageTokens !== undefined && { tokensOut: usage.outputImageTokens }),
    ...(usage.cachedInputTokens !== undefined && { cachedIn: usage.cachedInputTokens }),
  };
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
