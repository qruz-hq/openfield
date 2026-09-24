import type { CostEstimate, JobHandle, ModelManifest, NormalizedRequest } from "@openfield/core";
import type { BatchApi } from "./batch";
import type { CallContext } from "./provider";
import type { JobUpdate } from "./result";

// §6.3. The manifest plus behaviour. Cost before a run is the pure estimate() in the manifest
// entry, not a method, because the browser can't call one (§0.13).

export interface ImageModel extends ModelManifest {
  /**
   * Maps and sends. Queue APIs return once the provider accepts the job. Blocking APIs make the call
   * here and return a handle that already carries the result, so the first poll() succeeds.
   *
   * At a speed in `resumableSpeeds` (§6.3), submit() must return as soon as the company has the call
   * and its id, with `providerRef` set and no result, and the handle must be everything poll() and
   * cancel() need, as plain JSON. The runner stores it before the first poll, so a restarted server
   * can pick the call up by id instead of sending it again.
   */
  submit(req: NormalizedRequest, ctx: CallContext): Promise<JobHandle>;

  /**
   * Single status check. Idempotent, and safe after a terminal state: a finished call's image is
   * written through ctx.assets once per sink, however often it's polled. For a resumable call it
   * works from a stored handle in a fresh process, and an id the company no longer has throws a
   * ProviderError with `notFound: true` (notFoundError()).
   */
  poll(handle: JobHandle, ctx: CallContext): Promise<JobUpdate>;

  /** Optional streaming, including partial images. */
  stream?(handle: JobHandle, ctx: CallContext): AsyncIterable<JobUpdate>;

  /** Optional provider-side cancel. Without it the runner stops waiting (§0.12). */
  cancel?(handle: JobHandle, ctx: CallContext): Promise<void>;

  /** Optional: one round-trip to a documented cost endpoint. Never on the render path. */
  estimateRemote?(req: NormalizedRequest, ctx: CallContext): Promise<CostEstimate>;

  /**
   * The provider batch path (§6.7). Required when the manifest offers the "batch" speed. Standard,
   * Flex and Priority go through submit and poll, reading ctx.speed.
   */
  batch?: BatchApi;
}
