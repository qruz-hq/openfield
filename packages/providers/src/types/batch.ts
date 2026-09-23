import type { BatchHandle, BatchState, NormalizedRequest } from "@openfield/core";
import type { ProviderError } from "./errors";
import type { CallContext } from "./provider";
import type { JobResult } from "./result";

// §6.7: the provider batch path. One job set at the Batch speed is one provider batch of N
// requests, each keyed by its job id, so results map back to tiles without guessing at order.

/** One request's outcome, keyed by the job it belongs to. */
export type BatchItem = { jobId: string } & (
  | { ok: true; result: JobResult }
  | { ok: false; error: ProviderError }
);

export interface BatchUpdate {
  state: Exclude<BatchState, "submitting">;
  counts?: { total: number; succeeded: number; failed: number; pending: number };
  /**
   * Present once the batch is terminal, after a cancel too: one item per job id in `harvest`, and
   * only those. A job with no result by then (expired, canceled) comes back as an error item.
   */
  items?: BatchItem[];
  /** The whole batch failed. Items that finished first are still in `items`. */
  error?: ProviderError;
  /** Overrides the runner's poll schedule. */
  nextPollAfterMs?: number;
}

export interface BatchApi {
  /** One create call for every request of the job set. Not idempotent at most companies. */
  submit(reqs: NormalizedRequest[], ctx: CallContext): Promise<BatchHandle>;
  /**
   * One status read. Idempotent and safe after a terminal state. Writes assets through ctx.assets
   * only for the job ids in `harvest`, so a harvest cut short by a restart never duplicates. A
   * write that fails comes back as that job's error item, never as a thrown poll.
   */
  poll(handle: BatchHandle, ctx: CallContext, opts: { harvest: readonly string[] }): Promise<BatchUpdate>;
  /** Best effort. The runner keeps polling until the company reports a terminal state. */
  cancel(handle: BatchHandle, ctx: CallContext): Promise<void>;
  /** Optional: delete the batch and any uploaded inputs at the company once results are saved. */
  cleanup?(handle: BatchHandle, ctx: CallContext): Promise<void>;
  /**
   * Optional: find a batch whose create call may have succeeded before its id was stored. Null only
   * when the company answered and has none; throws when it couldn't be asked.
   */
  find?(displayName: string, ctx: CallContext): Promise<BatchHandle | null>;
}
