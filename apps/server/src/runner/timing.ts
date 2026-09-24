import {
  batchPollIntervalMs,
  FLEX_BUSY_BACKOFF_MS,
  FLEX_JOB_DEADLINE_MS,
  type ModelManifest,
  type SpeedId,
} from "@openfield/core";
import { speedTimeouts } from "@openfield/providers/manifest";

// Delays for the runner (§0.4, §0.12): poll backoff, retry backoff and Flex busy waits, all with
// ±20 % jitter, plus the batch poll schedule.

export interface QueueOptions {
  /** Attempt 1 plus retries (§0.12). */
  maxAttempts: number;
  /** Wait before retry n, by attempt. Retry-After always wins. */
  retryDelaysMs: readonly number[];
  /** Whole-job wall clock across every attempt. */
  jobDeadlineMs: number;
  /** Overrides the manifest's limits.requestTimeoutMs, for tests. */
  attemptTimeoutMs?: number;
  /** How often the scheduler looks for work even when nothing happened (§8.4.1). */
  heartbeatMs: number;
  poll: { firstMs: number; factor: number; capMs: number };
  jitter: number;
  /** Whole-job wall clock at Flex, busy waits included. */
  flexJobDeadlineMs: number;
  /** Wait after each Flex busy answer; the last one repeats. Retry-After wins. */
  flexBusyDelaysMs: readonly number[];
  /** Replaces the batch poll schedule, for tests. */
  batchPollMs?: number;
}

/**
 * Checks in a row with no answer from the company before a call that resumes (a Batch run, or a
 * sync call picked up by id) stops waiting past its deadline. Several, on the slower batch schedule,
 * so a network that is still coming up at boot never throws away an image that finished while
 * Openfield was closed.
 */
export const MISSES_PAST_DEADLINE = 3;

export const QUEUE_DEFAULTS: QueueOptions = {
  maxAttempts: 3,
  retryDelaysMs: [1_000, 4_000, 15_000],
  jobDeadlineMs: 900_000,
  heartbeatMs: 1_000,
  poll: { firstMs: 800, factor: 1.6, capMs: 5_000 },
  jitter: 0.2,
  flexJobDeadlineMs: FLEX_JOB_DEADLINE_MS,
  flexBusyDelaysMs: FLEX_BUSY_BACKOFF_MS,
};

export const jittered = (ms: number, ratio: number): number =>
  Math.max(0, Math.round(ms * (1 - ratio + Math.random() * 2 * ratio)));

export function retryDelay(opts: QueueOptions, attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = opts.retryDelaysMs[Math.min(attempt - 1, opts.retryDelaysMs.length - 1)] ?? 1_000;
  return jittered(base, opts.jitter);
}

/** The wait after the `busyCount`th Flex busy answer in a row (1 for the first). */
export function busyDelay(opts: QueueOptions, busyCount: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const delays = opts.flexBusyDelaysMs;
  const base = delays[Math.min(Math.max(1, busyCount), delays.length) - 1] ?? 30_000;
  return jittered(base, opts.jitter);
}

export function pollDelay(opts: QueueOptions, poll: number, hint?: number): number {
  if (hint !== undefined) return hint;
  const { firstMs, factor, capMs } = opts.poll;
  return jittered(Math.min(capMs, firstMs * factor ** poll), opts.jitter);
}

/** The next poll of a provider batch sent `elapsedMs` ago. The adapter's hint wins. */
export function batchPollDelay(opts: QueueOptions, elapsedMs: number, fake: boolean, hint?: number): number {
  if (hint !== undefined) return hint;
  return opts.batchPollMs ?? batchPollIntervalMs(elapsedMs, { fake });
}

/** One call's timeout and the whole job's deadline at a speed (§0.12). */
export function runTimeouts(
  opts: QueueOptions,
  manifest: Pick<ModelManifest, "capabilities" | "speeds">,
  speed: SpeedId,
): { attemptMs: number; deadlineMs: number } {
  const t = speedTimeouts(manifest, speed, { jobDeadlineMs: opts.jobDeadlineMs });
  return {
    attemptMs: opts.attemptTimeoutMs ?? t.attemptTimeoutMs,
    deadlineMs: speed === "flex" ? opts.flexJobDeadlineMs : t.jobDeadlineMs,
  };
}

/** Resolves after `ms`, or rejects with the signal's reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
