import type { CanvasNodeResult } from "@openfield/core/canvas";
import { isPendingFingerprint } from "./fingerprint";
import { STANDING_BLOCKERS } from "./inputs";
import type { NodeBlocker, NodeDisplay, NodeRuntime } from "./types";

// What a node draws (§7.5 node states): one state band plus an optional chip. Pure, so every case
// is unit tested. First match wins.

export interface DisplayInput {
  result: CanvasNodeResult | null;
  runtime: NodeRuntime | undefined;
  /** The node's current fingerprint; undefined while the first pass is still running. */
  fingerprint: string | undefined;
  /** What the live analysis says stops the node right now. */
  blocker: NodeBlocker | null;
  fanOut: number;
  /** The live analysis: its settings match but the images coming in aren't the ones it used. */
  inputsChanged?: boolean;
}

/**
 * Key and model problems show as soon as they exist. Input problems (no prompt, nothing connected)
 * only show once a run tried and hit them, so a node just added doesn't open on a warning.
 */
export function visibleBlocker(
  live: NodeBlocker | null,
  runtime: NodeRuntime | undefined,
): NodeBlocker | null {
  // Only the server can tell that an earlier node failed. That stays until the next run, or until
  // the earlier node has its images again (the follower clears it then).
  if (runtime?.state === "blocked" && runtime.blocker && RUN_ONLY_BLOCKERS.has(runtime.blocker.kind))
    return runtime.blocker;
  if (!live) return null;
  if (STANDING_BLOCKERS.has(live.kind)) return live;
  return runtime?.blocker && runtime.blocker.kind === live.kind ? live : null;
}

/** Blockers only a run can find. */
export const RUN_ONLY_BLOCKERS: ReadonlySet<NodeBlocker["kind"]> = new Set([
  "upstream_failed",
  "missing_input",
  "missing_asset",
]);

/** The node's settings moved on from those a run was sent with. Unknown either way counts as not. */
const changedSince = (sent: string | null, current: string | undefined): boolean =>
  !!sent && current !== undefined && !isPendingFingerprint(current) && current !== sent;

export function deriveDisplay({
  result,
  runtime,
  fingerprint,
  blocker,
  fanOut,
  inputsChanged = false,
}: DisplayInput): NodeDisplay {
  const base = { blocker: null, fanOut, chip: null } as const;
  if (runtime && (runtime.state === "queued" || runtime.state === "running")) {
    return { ...base, state: runtime.state };
  }
  if (blocker) return { ...base, state: "blocked", blocker };

  // A run stopped before it made anything leaves the saved result alone (resultOfRunNode), so the
  // stop itself says Canceled (znre4, or jxhcX over the last image) until the next run or a change
  // to the node. A stop that kept some images says the same from its saved result, below.
  if (runtime?.state === "canceled" && !changedSince(runtime.fingerprint, fingerprint)) {
    return { ...base, state: "canceled" };
  }

  // Before the first pass (or while a digest is still coming), trust the saved result.
  const matches =
    !result ||
    fingerprint === undefined ||
    (!isPendingFingerprint(fingerprint) && fingerprint === result.fingerprint);
  const images = (result?.assetIds.length ?? 0) > 0;

  if (result && (result.state === "failed" || result.state === "canceled")) {
    // A stopped run can leave some images behind; they stay on show under the band.
    if (matches) return { ...base, state: result.state };
    if (!images) return { ...base, state: "idle" };
  }
  if (!result || !images) return { ...base, state: "idle" };
  if (matches && !inputsChanged) {
    return { ...base, state: "done", chip: runtime?.skipped ? "up_to_date" : null };
  }
  const late = !inputsChanged && (runtime?.late || result.late);
  return { ...base, state: "stale", chip: late ? "older_settings" : "inputs_changed" };
}
