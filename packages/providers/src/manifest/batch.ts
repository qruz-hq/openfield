import type { ModelManifest } from "@openfield/core";

// Whether a run's images go to the company in one call or one call each (§6.5 step 5). normalize's
// planCalls, the runner's scheduler and the estimate all read it here, so a run is planned, sent
// and priced the same way.

/**
 * True when a model makes a run's whole count in one call: natively, or as a related set when the
 * request turns on the manifest's group option. A Batch-speed run still splits (planCalls).
 */
export function inOneCall(
  manifest: Pick<ModelManifest, "capabilities">,
  req: { providerOptions?: Readonly<Record<string, unknown>> | undefined },
): boolean {
  return manifest.capabilities.batch.native || isGroupRun(manifest, req);
}

/** A related set: one call whose image count the model may answer short of. */
export function isGroupRun(
  manifest: Pick<ModelManifest, "capabilities">,
  req: { providerOptions?: Readonly<Record<string, unknown>> | undefined },
): boolean {
  const option = manifest.capabilities.batch.groupOption;
  return option !== undefined && req.providerOptions?.[option] === true;
}
