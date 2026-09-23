import type { CostEstimate, JobHandle, ModelManifest, NormalizedRequest } from "@openfield/core";
import type { CallContext } from "./provider";
import type { JobUpdate } from "./result";

// §6.3. The manifest plus behaviour. Cost before a run is the pure estimate() in the manifest
// entry, not a method, because the browser can't call one (§0.13).

export interface ImageModel extends ModelManifest {
  /**
   * Maps and sends. Queue APIs return once the provider accepts the job. Blocking APIs make the call
   * here and return a handle that already carries the result, so the first poll() succeeds.
   */
  submit(req: NormalizedRequest, ctx: CallContext): Promise<JobHandle>;

  /** Single status check. Idempotent, and safe after a terminal state. */
  poll(handle: JobHandle, ctx: CallContext): Promise<JobUpdate>;

  /** Optional streaming, including partial images. */
  stream?(handle: JobHandle, ctx: CallContext): AsyncIterable<JobUpdate>;

  /** Optional provider-side cancel. Without it the runner stops waiting (§0.12). */
  cancel?(handle: JobHandle, ctx: CallContext): Promise<void>;

  /** Optional: one round-trip to a documented cost endpoint. Never on the render path. */
  estimateRemote?(req: NormalizedRequest, ctx: CallContext): Promise<CostEstimate>;
}
