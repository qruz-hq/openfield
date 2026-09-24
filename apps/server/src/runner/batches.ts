import {
  BATCH_DEADLINE_GRACE_MS,
  type BatchCounts,
  type BatchHandle,
  type CancelResponse,
  DEFAULT_BATCH_EXPIRY_MS,
  isTerminalBatchState,
  isTerminalState,
  type NormalizedRequest,
  t,
} from "@openfield/core";
import {
  createProviderBatch,
  type Db,
  deleteProviderBatch,
  dueProviderBatches,
  finishProviderBatch,
  getJob,
  getJobSet,
  getProviderBatch,
  getProviderBatchForJobSet,
  type JobRow,
  type JobSetRow,
  jobsOf,
  markBatchCleaned,
  markBatchNotified,
  type ProviderBatchRow,
  recordBatchPoll,
  recordBatchSubmitted,
  recordKeyCheck,
  refreshJobSetStatus,
  resumableBatches,
  transitionJob,
  uncleanedBatches,
  updateProviderBatch,
} from "@openfield/db";
import { resumesAfterRestart, speedOffer } from "@openfield/providers/manifest";
import {
  type BatchApi,
  type BatchUpdate,
  type CallContext,
  errorFromFetchFailure,
  isProviderError,
  ProviderError,
} from "@openfield/providers/server";
import type { EventHub } from "../events/hub";
import type { AttemptSink, Ingest } from "../files/ingest";
import type { Logger } from "../log/logger";
import { toBatchUpdated } from "../mappers/job";
import type { CredentialService } from "../services/credentials";
import type { BoundModel, ModelService } from "../services/models";
import { batchAction, callsFor, finalReason, type Outcomes } from "./outcomes";
import { type CallContexts, noWrites } from "./provider-fetch";
import {
  batchPollDelay,
  MISSES_PAST_DEADLINE,
  type QueueOptions,
  retryDelay,
  runTimeouts,
  sleep,
} from "./timing";

// The batch watcher (§0.4, §8.4.1): a job set at the Batch speed goes to the company as one provider
// batch. The row is written before the create call and keeps the company's id the moment it
// returns, so a restart resumes polling instead of sending the run again, which could bill twice.
// A waiting batch holds no concurrency slot; its create, poll, cancel and cleanup calls do (§0.12).

type Terminal = "succeeded" | "failed" | "canceled" | "expired";

interface BatchRun {
  bound: BoundModel;
  api: BatchApi;
}

export interface BatchWatcherDeps {
  db: Db;
  models: ModelService;
  credentials: CredentialService;
  contexts: CallContexts;
  ingest: Ingest;
  events: EventHub;
  logger: Logger;
  jobLog: (entry: Record<string, unknown>) => void;
  outcomes: Outcomes;
  options: QueueOptions;
  /** Fake mode polls every second, so a fake batch lands in seconds (§0.12). */
  fake: boolean;
  /** A slot for one call about a waiting batch, or undefined while every slot is taken (§0.12). */
  slots: (providerId: string, modelKey: string) => (() => void) | undefined;
}

/** What the scheduler hands over: the set's waiting jobs and the slot's abort. */
export interface BatchSubmit {
  jobSetId: string;
  jobIds: string[];
  abort: AbortController;
  /** True while its create call, or a lookup of it, is out: what a stop waits for (§0.12). */
  calling?: boolean;
}

export class BatchWatcher {
  readonly #polling = new Set<string>();
  /** Batches a cancel was sent for since this server started. */
  readonly #canceling = new Set<string>();
  /** The last state and counts sent per batch, so an unchanged poll sends nothing. */
  readonly #sent = new Map<string, string>();
  /** Checks in a row that got no answer from the company, per batch, since this server started. */
  readonly #misses = new Map<string, number>();
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #stop = new AbortController();
  #stopping = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: BatchWatcherDeps) {}

  /** Resumes what was in flight at the last stop, then polls due batches on the heartbeat. */
  start(): void {
    this.#timer = setInterval(() => this.#pollDue(), this.deps.options.heartbeatMs);
    this.#timer.unref?.();
    this.#track(this.#resume());
  }

  async stop(drainMs: number): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    const all = Promise.allSettled([...this.#tasks]);
    await Promise.race([all, sleep(drainMs)]);
    // Always, even with nothing of its own running: a create waiting to try again is the runner's
    // unit, and it stops waiting here. Whatever is cut off resumes from its row at the next boot.
    this.#stop.abort(new DOMException("Shutting down", "AbortError"));
    await Promise.race([all, sleep(2_000)]);
  }

  /** Images of Batch runs still at the company, which the next start picks up from their row. */
  atCompany(): number {
    return resumableBatches(this.deps.db).reduce(
      (n, { jobs }) => n + jobs.filter((j) => j.status !== "pending").length,
      0,
    );
  }

  // Submit

  /**
   * Sends the set's waiting jobs as one provider batch. Everything up to the create call runs
   * before the first await, so a job is either still pending or already covered by a row.
   */
  async submit(unit: BatchSubmit): Promise<void> {
    const { db, outcomes } = this.deps;
    const set = getJobSet(db, unit.jobSetId);
    if (!set) return;
    const run = this.#bind(set);
    if (!run) {
      const error = new ProviderError("capability_unsupported", {
        message: `${set.providerId}:${set.modelId} can't run at the Batch speed`,
      });
      outcomes.fail(set, unit.jobIds, error, { speed: "batch" });
      return outcomes.finishSet(set.id);
    }
    if (!this.#context(run, set, new AbortController().signal)) {
      outcomes.fail(set, unit.jobIds, new ProviderError("auth_missing", { message: "No key is set" }), {
        speed: "batch",
      });
      return outcomes.finishSet(set.id);
    }

    const calls = callsFor(run.bound.manifest, set.requestJson, jobsOf(db, set.id));
    const hint = this.deps.credentials.resolve(set.providerId).hint;
    const created = db.transaction((tx) => {
      if (getProviderBatchForJobSet(tx, set.id)) return undefined;
      const sent = unit.jobIds.flatMap((id) => {
        const job = getJob(tx, id);
        const moved =
          job &&
          transitionJob(
            tx,
            id,
            "submitting",
            {
              attempt: job.attempt + 1,
              nextAttemptAt: null,
              errorCode: null,
              errorMessage: null,
              errorReason: null,
              errorAction: null,
              // Always true: a Batch run resumes from its row, so it never runs again on its own (§0.4).
              resumable: resumesAfterRestart(run.bound.manifest, "batch"),
            },
            { from: ["pending"] },
          );
        return moved ? [moved] : [];
      });
      if (sent.length === 0) return undefined;
      const batch = createProviderBatch(tx, {
        jobSetId: set.id,
        providerId: set.providerId,
        modelId: set.modelId,
        itemCount: sent.length,
        credentialHint: hint,
      });
      return { batch, sent };
    });
    if (!created) return this.#orphaned(set, unit.jobIds);

    const { batch, sent } = created;
    refreshJobSetStatus(db, set.id);
    for (const job of sent) {
      this.deps.events.publish("job.started", {
        jobSetId: set.id,
        jobId: job.id,
        idx: job.idx,
        startedAt: job.startedAt ?? new Date().toISOString(),
      });
    }
    this.#publish(batch);
    this.deps.jobLog({ event: "batch.submitting", jobSetId: set.id, batchId: batch.id, items: sent.length });

    const reqs = sent.map((job) => calls.get(job.id)).filter((c): c is NormalizedRequest => c !== undefined);
    const { maxAttempts } = this.deps.options;
    let handle: BatchHandle | null = null;
    let error: ProviderError | undefined;
    // A create that failed on the way may still have reached the company.
    let unsure = false;
    for (let attempt = 1; attempt <= maxAttempts && !handle; attempt++) {
      if (attempt > 1) {
        const wait = retryDelay(this.deps.options, attempt - 1, error?.retryAfterMs);
        if (!(await this.#pause(wait))) {
          // Stopping. A create the company refused left nothing there, so the next start sends it
          // again. One that may have reached it stays for the next start to look up by name.
          if (!unsure) this.#unsend(batch, set, sent, error, wait);
          return;
        }
        if (unsure) {
          // Creating a batch isn't idempotent: look it up by name before sending it again (§0.4).
          try {
            unit.calling = true;
            handle = await this.#find(run, set, batch.displayName);
          } catch (err) {
            error = asProviderError(err);
            if (error.retryable) continue;
            break;
          } finally {
            unit.calling = false;
          }
          if (handle) break;
          unsure = false;
        }
        // Canceled while waiting to try again: nothing reached the company, so don't send it now.
        if (getProviderBatch(db, batch.id)?.errorCode === "canceled") break;
      }
      // A stop waits for the create, so its id gets stored (§0.12). Only a forced stop cuts it off.
      const ctx = this.#context(run, set, this.#signal(run, unit.abort.signal, { throughStop: true }));
      if (!ctx) {
        error = new ProviderError("auth_missing", { message: "No key is set" });
        break;
      }
      try {
        unit.calling = true;
        handle = await untilAborted(() => run.api.submit(reqs, ctx), ctx.signal);
      } catch (err) {
        error = asProviderError(err, ctx.signal);
        // Cut off by a forced stop: the next boot looks it up by name.
        if (unit.abort.signal.aborted) return;
        if (!error.retryable) break;
        if (!refused(error)) unsure = true;
      } finally {
        unit.calling = false;
      }
    }
    if (!handle && unsure && run.api.find) {
      try {
        handle = await this.#find(run, set, batch.displayName);
        unsure = handle !== null;
      } catch {
        // Still can't tell: the lookup goes on below.
      }
    }
    if (handle) return this.#submitted(batch, set, handle);
    // It may be at the company and nothing could tell yet: look again on the batch schedule.
    if (unsure && run.api.find) return this.#lookLater(batch);
    this.#createFailed(
      batch,
      set,
      sent,
      error ?? new ProviderError("unknown", { message: "The create failed" }),
    );
  }

  /** The company has the batch: store its id at once, then wait on the poll schedule. */
  async #submitted(batch: ProviderBatchRow, set: JobSetRow, handle: BatchHandle): Promise<void> {
    const { db } = this.deps;
    // Saved as it is, so a key that slipped into it is scrubbed first (the adapter keeps them out).
    const saved = recordBatchSubmitted(db, batch.id, this.deps.logger.scrubKeys(handle), {
      nextPollAt: this.#nextPoll(0),
    });
    for (const job of jobsOf(db, set.id)) {
      if (!transitionJob(db, job.id, "queued", {}, { from: ["submitting"] })) continue;
      this.deps.events.publish("job.queued", { jobSetId: set.id, jobId: job.id, idx: job.idx });
    }
    refreshJobSetStatus(db, set.id);
    if (!saved) return;
    this.#publish(saved);
    this.deps.jobLog({ event: "batch.submitted", jobSetId: set.id, batchId: batch.id });
    // A cancel that landed while the create call was out goes now that there's an id to stop.
    if (saved.errorCode === "canceled") await this.#sendCancel(saved);
  }

  /**
   * Stopping while a create the company refused waits to try again: nothing is at the company, so
   * the row goes and the jobs wait in pending, and the next start sends the run like any other.
   * A cancel that came in meanwhile ends it instead.
   */
  #unsend(
    batch: ProviderBatchRow,
    set: JobSetRow,
    sent: readonly JobRow[],
    error: ProviderError | undefined,
    waitMs: number,
  ): void {
    const { db } = this.deps;
    const cause = error ?? new ProviderError("provider_unavailable", { message: "The create was refused" });
    if (getProviderBatch(db, batch.id)?.errorCode === "canceled") {
      this.#createFailed(batch, set, sent, cause);
      return;
    }
    const retryAt = new Date(Date.now() + waitMs).toISOString();
    db.transaction((tx) => {
      for (const job of sent) {
        transitionJob(
          tx,
          job.id,
          "pending",
          {
            nextAttemptAt: retryAt,
            errorCode: cause.code,
            errorMessage: this.deps.logger.scrub(cause.message),
          },
          { from: ["submitting"] },
        );
      }
      deleteProviderBatch(tx, batch.id);
    });
    refreshJobSetStatus(db, set.id);
    this.deps.jobLog({ event: "batch.unsent", jobSetId: set.id, batchId: batch.id });
  }

  /** Nothing reached the company, so nothing was spent. */
  #createFailed(
    batch: ProviderBatchRow,
    set: JobSetRow,
    sent: readonly JobRow[],
    error: ProviderError,
  ): void {
    const { db, outcomes } = this.deps;
    const canceled = getProviderBatch(db, batch.id)?.errorCode === "canceled";
    const done = finishProviderBatch(db, batch.id, {
      state: canceled ? "canceled" : "failed",
      errorCode: canceled ? "canceled" : error.code,
      errorMessage: this.deps.logger.scrub(error.message),
    });
    markBatchCleaned(db, batch.id);
    if (canceled) {
      for (const job of sent) outcomes.cancel(set, job.id, { discarded: false, from: ["submitting"] });
    } else {
      outcomes.fail(
        set,
        sent.map((j) => j.id),
        error,
        { speed: "batch", reason: finalReason(error), action: batchAction(error) },
      );
    }
    outcomes.finishSet(set.id);
    if (done) this.#publish(done);
  }

  /** A set that already has a provider batch never gets a second one: that could bill twice. */
  #orphaned(set: JobSetRow, jobIds: readonly string[]): void {
    for (const id of jobIds) {
      transitionJob(
        this.deps.db,
        id,
        "interrupted",
        { errorMessage: "This run already went to the company once" },
        { from: ["pending"] },
      );
    }
    this.deps.outcomes.finishSet(set.id);
  }

  // Poll

  #pollDue(): void {
    if (this.#stopping) return;
    for (const row of dueProviderBatches(this.deps.db, new Date().toISOString())) {
      if (this.#polling.has(row.id)) continue;
      const free = this.deps.slots(row.providerId, modelKeyOf(row));
      // Every slot is taken: it stays due, and the next heartbeat tries again (§0.12).
      if (!free) continue;
      this.#polling.add(row.id);
      const work = row.remoteId ? this.#poll(row) : this.#lookup(row);
      this.#track(
        work.finally(() => {
          this.#polling.delete(row.id);
          free();
        }),
      );
    }
  }

  async #poll(row: ProviderBatchRow): Promise<void> {
    const { db } = this.deps;
    const set = getJobSet(db, row.jobSetId);
    if (!set || !row.handle) return;
    const run = this.#bind(set);
    const waiting = jobsOf(db, set.id).filter((j) => !isTerminalState(j.status));
    // Turned off, or no key right now: a company that's off makes no calls, so wait (§0.6).
    if (!run) return await this.#noAnswer(row, set, run, waiting);

    // Canceled, or nothing here still wants a result: stop it at the company first.
    if ((row.errorCode === "canceled" || waiting.length === 0) && !this.#canceling.has(row.id)) {
      await this.#sendCancel(row);
      // The next start polls it again, and sends the cancel if it didn't get through.
      if (this.#stopping) return;
    }
    const sink = this.deps.ingest.sink();
    const ctx = this.#context(run, set, this.#signal(run), sink);
    if (!ctx) return await this.#noAnswer(row, set, run, waiting);

    let update: BatchUpdate;
    try {
      const handle = row.handle;
      update = await untilAborted(
        () => run.api.poll(handle, ctx, { harvest: waiting.map((j) => j.id) }),
        ctx.signal,
      );
    } catch (err) {
      sink.discardAll();
      const error = asProviderError(err, ctx.signal);
      if (error.code === "auth_invalid") {
        recordKeyCheck(db, set.providerId, { ok: false, code: error.code });
      }
      const otherKey = error.code === "auth_forbidden" && !this.#sameKey(row, set);
      // Past the deadline, a key that isn't the one it was sent with never will read it (§0.4).
      if (otherKey && this.#late(row, run)) {
        return await this.#end(row, set, run, "failed", waiting, this.#unreadable(set, "batchOtherKey"));
      }
      // A failed poll never fails the run: try again on the same schedule. A key that's rejected, or
      // isn't the one the run was sent with, may be put right while the company still holds it (§0.4).
      if (error.retryable || this.#stopping || error.code === "auth_invalid" || otherKey) {
        this.deps.logger.warn("Couldn't check on a batch. Trying again soon", {
          jobSetId: set.id,
          code: error.code,
        });
        return await this.#noAnswer(row, set, run, waiting);
      }
      const gone = error.code === "auth_forbidden";
      return await this.#end(
        row,
        set,
        run,
        "failed",
        waiting,
        gone ? this.#unreadable(set, "batchGone", error) : error,
      );
    }
    this.#misses.delete(row.id);

    // Whatever the company calls finished is collected, however late the answer comes.
    if (isTerminalBatchState(update.state)) return await this.#harvest(row, set, run, update, sink, waiting);
    sink.discardAll();
    if (this.#late(row, run)) return await this.#expire(row, set, run, waiting);
    const state = update.state as "queued" | "running";
    if (state === "running") this.#started(set, waiting);
    const next = recordBatchPoll(db, row.id, {
      state,
      nextPollAt: this.#nextPoll(this.#elapsed(row), update.nextPollAfterMs),
    });
    if (next) this.#publish(next, update.counts);
  }

  /**
   * No answer from the company this time: check again on the batch schedule. Past the deadline the
   * run stops waiting only after several checks in a row got nothing, so a slow network at boot
   * never throws away a run that finished while Openfield was closed.
   */
  async #noAnswer(
    row: ProviderBatchRow,
    set: JobSetRow,
    run: BatchRun | undefined,
    waiting: readonly JobRow[],
  ): Promise<void> {
    if (!this.#stopping) {
      const misses = (this.#misses.get(row.id) ?? 0) + 1;
      this.#misses.set(row.id, misses);
      if (misses >= MISSES_PAST_DEADLINE && this.#late(row, run)) {
        const company = this.deps.credentials.provider(set.providerId).meta.displayName;
        const error = new ProviderError("timeout", {
          message: "No answer about the batch by its deadline",
          userMessage: t("errors.batchUnchecked", { company }),
        });
        return this.#end(row, set, run, "failed", waiting, error);
      }
    }
    recordBatchPoll(this.deps.db, row.id, { nextPollAt: this.#nextPoll(this.#elapsed(row)) });
  }

  /** The company started on the batch: its waiting jobs are running now. */
  #started(set: JobSetRow, waiting: readonly JobRow[]): void {
    let moved = false;
    for (const job of waiting) {
      const row = transitionJob(this.deps.db, job.id, "running", {}, { from: ["submitting", "queued"] });
      if (!row) continue;
      moved = true;
      this.deps.events.publish("job.started", {
        jobSetId: set.id,
        jobId: job.id,
        idx: job.idx,
        startedAt: row.startedAt ?? new Date().toISOString(),
      });
    }
    if (moved) refreshJobSetStatus(this.deps.db, set.id);
  }

  /**
   * Files every result by job id: a succeeded item goes through ingest like a sync result, a failed
   * one fails its own job. The row takes its final state only after, so a crash mid-harvest resumes.
   */
  async #harvest(
    row: ProviderBatchRow,
    set: JobSetRow,
    run: BatchRun,
    update: BatchUpdate,
    sink: AttemptSink,
    waiting: readonly JobRow[],
  ): Promise<void> {
    const { outcomes } = this.deps;
    const manifest = run.bound.manifest;
    const calls = callsFor(manifest, set.requestJson, jobsOf(this.deps.db, set.id));
    const items = new Map((update.items ?? []).map((item) => [item.jobId, item]));
    const latencyMs = this.#elapsed(row);
    const unsaved: JobRow[] = [];

    for (const job of waiting) {
      const call = calls.get(job.id)!;
      const item = items.get(job.id);
      if (item?.ok) {
        const image = item.result.images.find((i) => !i.partial);
        const staged = image && sink.take(image.assetId);
        if (image && staged) {
          const speedUsed = item.result.speedUsed ?? "batch";
          outcomes.succeed({
            set,
            job,
            call,
            image,
            staged,
            cost: outcomes.cost(manifest, call, speedUsed, item.result),
            speedUsed,
            latencyMs,
            usage: item.result.usage,
          });
          continue;
        }
      }
      const error =
        item && !item.ok
          ? item.error
          : item?.ok
            ? new ProviderError("provider_error", { message: "The result held no image" })
            : (update.error ?? missingResult(update.state as Terminal));
      // Couldn't be saved here (a full disk): the company still holds it, so a later poll collects it.
      if (error.code === "disk_full") {
        unsaved.push(job);
        continue;
      }
      if (error.code === "canceled") {
        // Stopped before it was made, but the company may bill work that had started (§0.12).
        const each = outcomes.cost(manifest, call, "batch").each;
        outcomes.cancel(set, job.id, { discarded: true, each, speed: "batch" });
      } else {
        outcomes.fail(set, [job.id], error, {
          speed: "batch",
          latencyMs,
          reason: finalReason(error),
          action: batchAction(error),
        });
      }
    }
    sink.discardAll();
    if (unsaved.length) {
      this.deps.logger.warn("Couldn't save every image of a finished batch. Trying again soon", {
        jobSetId: set.id,
        images: unsaved.length,
      });
      this.#started(set, unsaved);
      const next = recordBatchPoll(this.deps.db, row.id, {
        state: "running",
        nextPollAt: this.#nextPoll(this.#elapsed(row)),
      });
      if (next) this.#publish(next, update.counts);
      return;
    }
    await this.#close(row, set, run, update.state as Terminal, update.error, { tidy: true });
  }

  /** The run ends without a harvest: every waiting job fails with `error`, and nothing is deleted. */
  async #end(
    row: ProviderBatchRow,
    set: JobSetRow,
    run: BatchRun | undefined,
    state: Terminal,
    waiting: readonly JobRow[],
    error: ProviderError,
  ): Promise<void> {
    this.deps.outcomes.fail(
      set,
      waiting.map((j) => j.id),
      error,
      { speed: "batch", reason: finalReason(error), action: batchAction(error) },
    );
    await this.#close(row, set, run, state, error);
  }

  /**
   * The row's final state. Only a run the company reported finished is deleted there: one ended
   * here without that answer may still have results at the company, so it's left for it to expire.
   */
  async #close(
    row: ProviderBatchRow,
    set: JobSetRow,
    run: BatchRun | undefined,
    state: Terminal,
    error?: ProviderError,
    opts: { tidy?: boolean } = {},
  ): Promise<void> {
    const done = finishProviderBatch(this.deps.db, row.id, {
      state,
      ...(state === "canceled" && { errorCode: "canceled" }),
      ...(state === "expired" && { errorCode: "timeout" }),
      ...(state === "failed" && {
        errorCode: error?.code ?? "provider_error",
        ...(error && { errorMessage: this.deps.logger.scrub(error.message) }),
      }),
    });
    this.deps.outcomes.finishSet(set.id);
    this.#sent.delete(row.id);
    this.#misses.delete(row.id);
    if (!done) return;
    this.#publish(done);
    this.deps.jobLog({ event: "batch.finished", jobSetId: set.id, batchId: row.id, state });
    if (opts.tidy) await this.#cleanup(done, run);
    else markBatchCleaned(this.deps.db, row.id);
  }

  /**
   * The company says it's still queued or running past its expiry plus a grace: it's stopped there
   * and its jobs fail as a timeout (§0.12).
   */
  async #expire(row: ProviderBatchRow, set: JobSetRow, run: BatchRun, waiting: readonly JobRow[]) {
    await this.#sendCancel(row);
    const company = this.deps.credentials.provider(set.providerId).meta.displayName;
    const hours = Math.round(this.#expiryMs(run) / 3_600_000);
    const error = new ProviderError("timeout", {
      message: "The batch passed its deadline",
      userMessage: t("errors.batchExpired", { company, hours }),
    });
    await this.#end(row, set, run, "expired", waiting, error);
  }

  /** Whether the key saved now is the one the run was sent with, as far as its last four tell. */
  #sameKey(row: ProviderBatchRow, set: JobSetRow): boolean {
    const hint = this.deps.credentials.resolve(set.providerId).hint;
    return !row.credentialHint || !hint || hint === row.credentialHint;
  }

  /** A batch the company won't show this key: sent with another key, or gone at the company. */
  #unreadable(set: JobSetRow, copy: "batchOtherKey" | "batchGone", cause?: ProviderError): ProviderError {
    const company = this.deps.credentials.provider(set.providerId).meta.displayName;
    return new ProviderError("auth_forbidden", {
      message: cause?.message ?? "The batch can't be read with the key saved now",
      userMessage: t(`errors.${copy}`, { company }),
      ...(cause?.httpStatus !== undefined && { httpStatus: cause.httpStatus }),
      ...(cause?.providerCode !== undefined && { providerCode: cause.providerCode }),
      hint: { action: "retry", label: t("actions.tryAgain") },
    });
  }

  // Cancel

  /**
   * Cancel stops the whole provider batch, never one image of it (§0.12). Jobs not sent yet cancel
   * at once. Sent ones are stopping: they stay until the company stops, so what finished first is kept.
   */
  cancel(set: JobSetRow, inFlight: (jobId: string) => boolean): CancelResponse {
    const { db, outcomes } = this.deps;
    const out: CancelResponse = { canceled: [], notCancelable: [], stopping: [] };
    const row = getProviderBatchForJobSet(db, set.id);
    const live = row !== undefined && row.finishedAt === null;
    for (const job of jobsOf(db, set.id)) {
      if (isTerminalState(job.status)) {
        out.notCancelable.push(job.id);
      } else if (job.status === "pending" && !inFlight(job.id)) {
        const moved = outcomes.cancel(set, job.id, { discarded: false, from: ["pending"] });
        (moved ? out.canceled : out.notCancelable).push(job.id);
      } else {
        (live ? out.stopping! : out.notCancelable).push(job.id);
      }
    }
    if (live) this.#requestCancel(row);
    outcomes.finishSet(set.id);
    return out;
  }

  #requestCancel(row: ProviderBatchRow): void {
    // Kept on the row, so a restart before the company answers still stops it.
    const marked = updateProviderBatch(this.deps.db, row.id, { errorCode: "canceled" }) ?? row;
    this.deps.jobLog({ event: "batch.cancel", jobSetId: row.jobSetId, batchId: row.id });
    // The tiles show they're stopping, and stop offering Cancel.
    this.#publish(marked);
    // Still being created: the create call sends the cancel once it has an id.
    if (marked.remoteId) this.#track(this.#inSlot(marked, () => this.#sendCancel(marked)));
  }

  async #sendCancel(row: ProviderBatchRow): Promise<void> {
    // Stopping: the row keeps its cancel, and the next start sends it.
    if (!row.handle || this.#canceling.has(row.id) || this.#stopping) return;
    const handle = row.handle;
    const set = getJobSet(this.deps.db, row.jobSetId);
    const run = set && this.#bind(set);
    const ctx = set && run && this.#context(run, set, this.#signal(run));
    if (!run || !ctx) return;
    this.#canceling.add(row.id);
    try {
      await untilAborted(() => run.api.cancel(handle, ctx), ctx.signal);
    } catch (err) {
      this.#canceling.delete(row.id);
      if (!this.#stopping) {
        this.deps.logger.warn("Couldn't stop a batch at the company. Trying again soon", {
          jobSetId: row.jobSetId,
          error: err,
        });
      }
    }
    // Poll at once, to harvest whatever finished before it stopped.
    const current = getProviderBatch(this.deps.db, row.id);
    if (current && current.finishedAt === null) {
      updateProviderBatch(this.deps.db, row.id, { nextPollAt: new Date().toISOString() });
    }
  }

  // Recovery (§8.4.5)

  async #resume(): Promise<void> {
    const rows = resumableBatches(this.deps.db);
    if (rows.length) {
      const unsent = rows.filter((r) => !r.batch.remoteId).length;
      this.deps.jobLog({ event: "startup.batches", resumed: rows.length - unsent, lookedUp: unsent });
    }
    // Every active batch is checked once at boot, a few at a time as slots allow. Its jobs keep their
    // state; nothing is interrupted. One whose create never answered is looked up by name first.
    const now = new Date().toISOString();
    for (const { batch } of rows) updateProviderBatch(this.deps.db, batch.id, { nextPollAt: now });
    this.#pollDue();
    for (const row of uncleanedBatches(this.deps.db)) {
      // Whatever is left untidied waits for the next start.
      if (this.#stopping) return;
      await this.#inSlot(row, () => this.#cleanup(row));
    }
  }

  /** It may have reached the company and nothing could tell yet: look again on the batch schedule. */
  #lookLater(batch: ProviderBatchRow): void {
    updateProviderBatch(this.deps.db, batch.id, { nextPollAt: this.#nextPoll(this.#elapsed(batch)) });
  }

  /**
   * A create whose answer never came back, looked up by name: found, its id is stored and polling
   * starts. Only a lookup that ran and found nothing ends the run. One that couldn't run (no key,
   * the company off, the network down) tries again on the batch schedule until the deadline.
   */
  async #lookup(row: ProviderBatchRow): Promise<void> {
    const set = getJobSet(this.deps.db, row.jobSetId);
    if (!set) return;
    const run = this.#bind(set);
    // No way to look it up: never sent again on its own.
    let handle: BatchHandle | null | undefined = run && !run.api.find ? null : undefined;
    if (run?.api.find) {
      try {
        handle = await this.#find(run, set, row.displayName);
      } catch (err) {
        if (!this.#stopping) {
          this.deps.logger.warn("Couldn't look up a batch at the company. Trying again soon", {
            jobSetId: set.id,
            code: asProviderError(err).code,
          });
        }
      }
    }
    if (handle) return this.#submitted(row, set, handle);
    if (handle === undefined) {
      if (this.#stopping) return;
      if (!this.#late(row, run)) return this.#lookLater(row);
    }
    this.#lost(row, set);
  }

  /** Nothing reached the company: the run ends and is never sent again on its own (§0.12). */
  #lost(row: ProviderBatchRow, set: JobSetRow): void {
    const { db, outcomes } = this.deps;
    const message = "This run didn't reach the company";
    const canceled = getProviderBatch(db, row.id)?.errorCode === "canceled";
    const done = finishProviderBatch(db, row.id, {
      state: canceled ? "canceled" : "failed",
      ...(canceled && { errorCode: "canceled" as const }),
      errorMessage: message,
    });
    markBatchCleaned(db, row.id);
    for (const job of jobsOf(db, set.id)) {
      if (isTerminalState(job.status)) continue;
      // Canceled while it was being sent: nothing was spent, so it simply ends canceled.
      if (canceled) outcomes.cancel(set, job.id, { discarded: false, from: ["pending", "submitting"] });
      else transitionJob(db, job.id, "interrupted", { errorMessage: message });
    }
    outcomes.finishSet(set.id);
    if (done) this.#publish(done);
  }

  /** Deletes the batch and its uploads at the company once its results are saved. */
  async #cleanup(row: ProviderBatchRow, known?: BatchRun): Promise<void> {
    const { db } = this.deps;
    // Stopping: the next start tidies it up (uncleanedBatches).
    if (row.cleanedAt || this.#stopping) return;
    const set = getJobSet(db, row.jobSetId);
    const run = known ?? (set && this.#bind(set));
    if (!row.handle || (run && !run.api.cleanup)) return void markBatchCleaned(db, row.id);
    if (!set || !run?.api.cleanup) return;
    const cleanup = run.api.cleanup.bind(run.api);
    const ctx = this.#context(run, set, this.#signal(run));
    if (!ctx) return;
    const handle = row.handle;
    try {
      await untilAborted(() => cleanup(handle, ctx), ctx.signal);
      markBatchCleaned(db, row.id);
    } catch (err) {
      // Cut off by the stop: the next start tidies it up (uncleanedBatches), so it isn't news.
      if (this.#stopping) return;
      this.deps.logger.warn("Couldn't tidy up a finished batch at the company", {
        jobSetId: row.jobSetId,
        error: err,
      });
    }
  }

  // Helpers

  /** Null only when the company was asked and has no such batch; throws when it couldn't be asked. */
  async #find(run: BatchRun, set: JobSetRow, displayName: string): Promise<BatchHandle | null> {
    if (!run.api.find) return null;
    const ctx = this.#context(run, set, this.#signal(run));
    if (!ctx) throw new ProviderError("auth_missing", { message: "No key is set, or the company is off" });
    const find = run.api.find.bind(run.api);
    return untilAborted(() => find(displayName, ctx), ctx.signal);
  }

  /** Runs one call about a batch in a slot, waiting for one to free up (§0.12). */
  async #inSlot(row: ProviderBatchRow, work: () => Promise<void>): Promise<void> {
    for (;;) {
      // Stopping: nothing new goes out, and the next start redoes it.
      if (this.#stopping) return;
      const free = this.deps.slots(row.providerId, modelKeyOf(row));
      if (free) {
        try {
          return await work();
        } finally {
          free();
        }
      }
      if (!(await this.#pause(this.deps.options.heartbeatMs))) return;
    }
  }

  /**
   * Sends batch.updated when the state or counts changed. A finished one counts as announced once a
   * tab has it (§2.4).
   */
  #publish(row: ProviderBatchRow, counts?: BatchCounts): void {
    const frame = toBatchUpdated(row, jobsOf(this.deps.db, row.jobSetId), {
      counts: row.finishedAt ? undefined : counts,
      canvasId: getJobSet(this.deps.db, row.jobSetId)?.canvasId,
    });
    const c = frame.counts;
    const key = JSON.stringify([frame.state, frame.stopping, c?.total, c?.succeeded, c?.failed, c?.pending]);
    if (!frame.finished && this.#sent.get(row.id) === key) return;
    if (!frame.finished) this.#sent.set(row.id, key);
    const delivered = this.deps.events.publish("batch.updated", frame);
    if (delivered && frame.finished) markBatchNotified(this.deps.db, row.id);
  }

  #bind(set: JobSetRow): BatchRun | undefined {
    try {
      const bound = this.deps.models.bind(`${set.providerId}:${set.modelId}`);
      return bound.model.batch ? { bound, api: bound.model.batch } : undefined;
    } catch {
      return undefined;
    }
  }

  #context(run: BatchRun, set: JobSetRow, signal: AbortSignal, sink?: AttemptSink): CallContext | null {
    const assets = sink ?? noWrites((id) => this.deps.ingest.read(id));
    return this.deps.contexts.for(run.bound.provider, signal, assets, {
      settings: set.requestJson.providerSettings,
      speed: "batch",
    });
  }

  /**
   * One call's signal: its own timeout, anything the caller adds, and the shutdown unless the call
   * must run through it.
   */
  #signal(run: BatchRun, extra?: AbortSignal, opts: { throughStop?: boolean } = {}): AbortSignal {
    const { attemptMs } = runTimeouts(this.deps.options, run.bound.manifest, "batch");
    return AbortSignal.any([
      ...(opts.throughStop ? [] : [this.#stop.signal]),
      AbortSignal.timeout(attemptMs),
      ...(extra ? [extra] : []),
    ]);
  }

  #deadline(row: ProviderBatchRow, run: BatchRun | undefined): number {
    if (row.expiresAt) return Date.parse(row.expiresAt) + BATCH_DEADLINE_GRACE_MS;
    const sent = Date.parse(row.submittedAt ?? row.createdAt);
    return sent + this.#expiryMs(run) + BATCH_DEADLINE_GRACE_MS;
  }

  #late(row: ProviderBatchRow, run: BatchRun | undefined): boolean {
    return Date.now() > this.#deadline(row, run);
  }

  #expiryMs(run: BatchRun | undefined): number {
    return (run && speedOffer(run.bound.manifest, "batch")?.waitMs.max) ?? DEFAULT_BATCH_EXPIRY_MS;
  }

  #elapsed(row: ProviderBatchRow): number {
    return Math.max(0, Date.now() - Date.parse(row.submittedAt ?? row.createdAt));
  }

  #nextPoll(elapsedMs: number, hint?: number): string {
    const delay = batchPollDelay(this.deps.options, elapsedMs, this.deps.fake, hint);
    return new Date(Date.now() + delay).toISOString();
  }

  /** Waits, unless the server is stopping. False when it is. */
  async #pause(ms: number): Promise<boolean> {
    try {
      await sleep(ms, this.#stop.signal);
      return !this.#stopping;
    } catch {
      return false;
    }
  }

  #track(task: Promise<unknown>): void {
    const tracked = task
      .catch((err) => this.deps.logger.error("A batch check stopped unexpectedly", { error: err }))
      .finally(() => this.#tasks.delete(tracked));
    this.#tasks.add(tracked);
  }
}

const modelKeyOf = (row: ProviderBatchRow) => `${row.providerId}:${row.modelId}`;

/**
 * The company answered and plainly didn't take the call: too many requests, or overloaded. Anything
 * else that failed on the way (the network, a timeout, a 500) may have created the batch anyway.
 */
export const refused = (error: ProviderError) => error.httpStatus === 429 || error.httpStatus === 503;

function missingResult(state: Terminal): ProviderError {
  if (state === "canceled")
    return new ProviderError("canceled", { message: "Stopped before this image was made" });
  if (state === "expired") return new ProviderError("timeout", { message: "The batch expired first" });
  return new ProviderError("provider_error", { message: "The company sent no result for this image" });
}

export function asProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  if (isProviderError(err)) return err;
  if (signal?.aborted) return errorFromFetchFailure(err, signal);
  return new ProviderError("unknown", {
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

/**
 * Stops waiting when the signal fires, even if an adapter ignores it. Pass the call as a function,
 * so nothing is sent once the signal has fired. A call already under way still has its own failure
 * handled after the wait ends: Bun exits on an unhandled rejection, which would cut off every other
 * call the server is finishing.
 */
export function untilAborted<T>(work: Promise<T> | (() => Promise<T>), signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    if (typeof work !== "function") work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  let running: Promise<T>;
  try {
    running = typeof work === "function" ? work() : work;
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    running.then(
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
