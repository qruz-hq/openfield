// Delays for the runner (§0.4): poll backoff and retry backoff, both with ±20 % jitter.

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
}

export const QUEUE_DEFAULTS: QueueOptions = {
  maxAttempts: 3,
  retryDelaysMs: [1_000, 4_000, 15_000],
  jobDeadlineMs: 900_000,
  heartbeatMs: 1_000,
  poll: { firstMs: 800, factor: 1.6, capMs: 5_000 },
  jitter: 0.2,
};

export const jittered = (ms: number, ratio: number): number =>
  Math.max(0, Math.round(ms * (1 - ratio + Math.random() * 2 * ratio)));

export function retryDelay(opts: QueueOptions, attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = opts.retryDelaysMs[Math.min(attempt - 1, opts.retryDelaysMs.length - 1)] ?? 1_000;
  return jittered(base, opts.jitter);
}

export function pollDelay(opts: QueueOptions, poll: number, hint?: number): number {
  if (hint !== undefined) return hint;
  const { firstMs, factor, capMs } = opts.poll;
  return jittered(Math.min(capMs, firstMs * factor ** poll), opts.jitter);
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
