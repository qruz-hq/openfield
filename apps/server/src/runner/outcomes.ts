import {
  type CostEstimate,
  type CostSource,
  canvasSource,
  DEFAULT_CURRENCY,
  type ErrorAction,
  errorCopy,
  formatMoney,
  isTerminalState,
  type JobState,
  type ModelManifest,
  type NormalizedRequest,
  type SpeedId,
  THUMB_RUNGS,
  t,
  type UsageUnits,
} from "@openfield/core";
import {
  type AssetRow,
  assetsForJobSets,
  type Db,
  getAsset,
  getJobSet,
  insertAsset,
  insertAssetEdges,
  insertUsage,
  type JobRow,
  type JobSetRow,
  jobsOf,
  refreshJobSetStatus,
  transitionJob,
  updateJobSet,
} from "@openfield/db";
import { estimate } from "@openfield/providers/manifest";
import {
  type GeneratedImage,
  type JobResult,
  type ProviderError,
  type ProviderUsage,
  planCalls,
} from "@openfield/providers/server";
import type { EventHub } from "../events/hub";
import type { Ingest, StagedFile } from "../files/ingest";
import { Thumbs } from "../files/thumbs";
import type { Logger } from "../log/logger";
import { toAssetListItem } from "../mappers/asset";
import type { SettingsService } from "../services/settings";

// How a job ends, shared by the sync runner and the batch watcher: the asset, the usage row and
// the event are written together, and every move is guarded so a late result never beats a cancel.

const IN_FLIGHT: readonly JobState[] = ["submitting", "queued", "running"];

export interface OutcomeDeps {
  db: Db;
  events: EventHub;
  ingest: Ingest;
  thumbs: Thumbs;
  settings: SettingsService;
  logger: Logger;
  jobLog: (entry: Record<string, unknown>) => void;
  /** OPENFIELD_FAKE_PROVIDERS=1: every cost is 0 and no row counts toward spend (§0.13). */
  fake: boolean;
}

export interface ImageCost {
  each: CostEstimate;
  costUsd: number | null;
  costSource: CostSource;
}

/** What a job set carries of the price it was sent at. */
export type SetPrice = Pick<JobSetRow, "costEstimateUsd" | "batchSize" | "createdAt">;

/** One image's share of the price a run was sent at, or undefined when it carries none. */
export function eachFromSet(set: SetPrice): CostEstimate | undefined {
  if (set.costEstimateUsd === null || set.batchSize < 1) return undefined;
  const each = Math.round((set.costEstimateUsd / set.batchSize) * 1e6) / 1e6;
  return {
    currency: DEFAULT_CURRENCY,
    min: each,
    max: each,
    confidence: "estimated",
    basis: t("cost.basis", { count: 1, each: formatMoney(each, DEFAULT_CURRENCY, true) }),
    pricedAt: set.createdAt.slice(0, 10),
  };
}

export class Outcomes {
  constructor(private readonly deps: OutcomeDeps) {}

  get fake(): boolean {
    return this.deps.fake;
  }

  /**
   * One image's cost at the speed the company served, never the one asked for (§0.13). A model
   * priced per request has no price of its own, so its share of what the company answered when the
   * run was sent stands in (§6.9).
   */
  cost(
    manifest: ModelManifest,
    call: NormalizedRequest,
    speed: SpeedId,
    result?: JobResult,
    set?: SetPrice,
  ): ImageCost {
    const local = estimate(manifest, { ...call, batch: 1, speed });
    const each = local.confidence === "unknown" && set ? (eachFromSet(set) ?? local) : local;
    const images = Math.max(1, result?.images.filter((i) => !i.partial).length ?? 1);
    const known = each.confidence === "unknown" ? null : each.max;
    const costUsd = result?.cost ? result.cost.amount / images : known;
    const costSource = result?.cost?.confidence ?? (each.confidence === "unknown" ? "unknown" : "estimated");
    return { each, costUsd: this.deps.fake ? 0 : costUsd, costSource };
  }

  /**
   * Files one image for one job: the asset, its lineage and a usage row, in the transaction that
   * marks the job succeeded. Undefined when the job had already moved on (a cancel won).
   */
  succeed(args: {
    set: JobSetRow;
    job: JobRow;
    call: NormalizedRequest;
    image: GeneratedImage;
    staged: StagedFile;
    cost: ImageCost;
    speedUsed: SpeedId;
    latencyMs: number;
    usage?: ProviderUsage | undefined;
  }): AssetRow | undefined {
    const { set, job, call, image, staged, cost, speedUsed, latencyMs } = args;
    const base = call.base?.assetId;
    const committed = this.deps.db.transaction((tx) => {
      const moved = transitionJob(
        tx,
        job.id,
        "succeeded",
        { progress: 1, latencyMs, seed: image.seed ?? job.seed, speedUsed, nextAttemptAt: null },
        { from: IN_FLIGHT },
      );
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
        costUsd: cost.costUsd,
        parentAssetId: base ?? null,
        rootAssetId: base
          ? (getAsset(tx, base, { includeDeleted: true })?.rootAssetId ?? base)
          : staged.assetId,
        op: set.op,
        // Drives "Open in Canvas" in the detail view (§7.1).
        opParams: call.canvas ? { source: canvasSource(call.canvas.canvasId, call.canvas.nodeId) } : null,
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
        units: unitsOf(args.usage),
        estimateMin: cost.each.min,
        estimateMax: cost.each.max,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        priceAsOf: cost.each.pricedAt || null,
        latencyMs,
        speed: speedUsed,
        simulated: this.deps.fake,
        rerun: job.rerunAt !== null,
      });
      return asset;
    });

    if (!committed) {
      this.deps.ingest.discard(staged);
      return undefined;
    }
    this.deps.events.publish("job.output", {
      jobSetId: set.id,
      jobId: job.id,
      idx: job.idx,
      asset: toAssetListItem(committed, false, job.rerunAt !== null),
    });
    this.deps.jobLog({
      event: "job.succeeded",
      jobId: job.id,
      jobSetId: set.id,
      assetId: committed.id,
      latencyMs,
      speed: speedUsed,
    });
    const rung = THUMB_RUNGS[this.deps.settings.get().feedZoom] ?? 456;
    this.deps.thumbs.warm(committed, Thumbs.sizeFor({ h: rung }));
    return committed;
  }

  /**
   * Terminal failure. A failed job logs usage at no cost, never added to spend (§0.13). `reason`
   * replaces the tile copy the error would give, and `action` the tile's button.
   */
  fail(
    set: JobSetRow,
    jobIds: readonly string[],
    error: ProviderError,
    opts: {
      latencyMs?: number | undefined;
      speed?: SpeedId;
      reason?: string | null;
      action?: ErrorAction | null;
    } = {},
  ): void {
    const message = this.deps.logger.scrub(error.message);
    const reason = opts.reason === undefined ? tileReason(error) : opts.reason;
    const action = opts.action === undefined ? hintAction(error) : opts.action;
    for (const jobId of jobIds) {
      const moved = this.deps.db.transaction((tx) => {
        const job = transitionJob(tx, jobId, "failed", {
          errorCode: error.code,
          errorMessage: message,
          errorReason: reason,
          errorAction: action,
          nextAttemptAt: null,
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
          latencyMs: opts.latencyMs ?? null,
          httpStatus: error.httpStatus ?? null,
          speed: opts.speed ?? set.speed,
          simulated: this.deps.fake,
          rerun: job.rerunAt !== null,
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
          ...(action && { action }),
        },
      });
    }
  }

  /**
   * Cancels one job. Not sent yet: nothing was spent. Sent: the company may still bill it, so it's
   * logged at the estimate, marked discarded (§0.12).
   */
  cancel(
    set: JobSetRow,
    jobId: string,
    opts:
      | { discarded: false; from?: readonly JobState[] }
      | { discarded: true; each: CostEstimate | undefined; speed: SpeedId },
  ): JobRow | undefined {
    const moved = this.deps.db.transaction((tx) => {
      const row = transitionJob(
        tx,
        jobId,
        "canceled",
        { errorCode: "canceled", nextAttemptAt: null },
        opts.discarded ? {} : { from: opts.from ?? ["pending", "queued"] },
      );
      if (!row || !opts.discarded) return row;
      const each = opts.each;
      const known = each && each.confidence !== "unknown";
      insertUsage(tx, {
        providerId: set.providerId,
        modelId: set.modelId,
        jobSetId: set.id,
        jobId,
        batchIndex: row.idx,
        operation: set.op,
        outcome: "canceled",
        estimateMin: each?.min ?? null,
        estimateMax: each?.max ?? null,
        costUsd: known ? (this.deps.fake ? 0 : each.max) : null,
        costSource: known ? "estimated" : "unknown",
        priceAsOf: each?.pricedAt || null,
        discarded: true,
        speed: opts.speed,
        simulated: this.deps.fake,
        rerun: row.rerunAt !== null,
      });
      return row;
    });
    if (!moved) return undefined;
    this.deps.events.publish("job.canceled", {
      jobSetId: set.id,
      jobId,
      idx: moved.idx,
      discarded: opts.discarded,
    });
    this.deps.jobLog({ event: "job.canceled", jobId, jobSetId: set.id, discarded: opts.discarded });
    return moved;
  }

  /**
   * Recomputes a set's status and emits job_set.completed on the move to a terminal state.
   * The only place that makes that move, so the event fires exactly once.
   */
  finishSet(jobSetId: string): void {
    const { db } = this.deps;
    const before = getJobSet(db, jobSetId);
    if (!before || isTerminalState(before.status)) return;
    const after = refreshJobSetStatus(db, jobSetId);
    if (!after || !isTerminalState(after.status)) return;

    const jobs = jobsOf(db, jobSetId);
    const costs = assetsForJobSets(db, [jobSetId]).map((a) => a.costUsd ?? 0);
    const firstFailure = jobs.find((j) => j.status === "failed");
    updateJobSet(db, jobSetId, {
      costActualUsd: this.deps.fake ? 0 : costs.length ? round(costs.reduce((a, b) => a + b, 0)) : null,
      errorCode: firstFailure?.errorCode ?? null,
      errorMessage: firstFailure?.errorMessage ?? null,
    });
    const done = getJobSet(db, jobSetId)!;
    this.deps.events.publish("job_set.completed", {
      jobSetId,
      status: done.status,
      costActualUsd: done.costActualUsd,
      durationMs: Math.max(0, Date.parse(done.finishedAt ?? done.createdAt) - Date.parse(done.createdAt)),
    });
    this.deps.events.publish("usage.updated", { jobSetId });
    this.deps.jobLog({ event: "job_set.completed", jobSetId, status: done.status });
  }
}

/**
 * Each job's request, from the frozen one (§6.5 step 5): the planned single-image call on fan-out,
 * or a copy of the request when the plan can't be rebuilt.
 */
export function callsFor(
  manifest: ModelManifest,
  request: NormalizedRequest,
  jobs: readonly JobRow[],
): Map<string, NormalizedRequest> {
  const planned =
    jobs.length === request.batch
      ? planCalls(
          manifest,
          request,
          jobs.map((j) => j.id),
        )
      : [];
  return new Map(
    jobs.map((job) => [
      job.id,
      planned.find((c) => c.jobId === job.id) ?? { ...request, jobId: job.id, batchIndex: job.idx, batch: 1 },
    ]),
  );
}

/**
 * The adapter's own copy for the tile, when it says more than the code's usual reason. A retryable
 * error only lands here once the retries ran out, so its "trying again" wording no longer holds.
 */
export function tileReason(error: ProviderError): string | null {
  if (error.retryable || error.userMessage === errorCopy(error.code).reason) return null;
  return error.userMessage;
}

/** The button an adapter's hint asks for, when the tile has one for it (§0.5, §6.8). */
export function hintAction(error: ProviderError): ErrorAction | null {
  switch (error.hint?.action) {
    case "open-settings":
      return "open-settings";
    case "retry":
      return "try-again";
    default:
      return null;
  }
}

/**
 * A Batch image that failed with a retryable code offers Try again: Openfield never resends a
 * batch on its own, because that could bill twice (§0.4).
 */
export function batchAction(error: ProviderError): ErrorAction | null {
  return error.retryable ? "try-again" : hintAction(error);
}

/** The adapter's copy even for a retryable code: a Batch run is never retried, so it's final. */
export function finalReason(error: ProviderError): string | null {
  return error.userMessage === errorCopy(error.code).reason ? null : error.userMessage;
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
