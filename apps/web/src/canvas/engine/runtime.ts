import type { ModelKey } from "@openfield/core";
import { type CanvasNodeResult, resultOfRunNode } from "@openfield/core/canvas";
import { isPendingFingerprint } from "./fingerprint";
import type { NodeBlocker, NodeRuntime, RunBlockReason, RunNodeState, RunState } from "./types";

// Server run state (canvas_run.updated, GET …/runs) into the store: live runtime per node, and
// for nodes that finished, the result the document keeps (§7.7, §7.8). Pure.

const TERMINAL = new Set(["done", "cached", "failed", "canceled", "blocked"]);
export const isTerminalNode = (state: RunNodeState["state"]): boolean => TERMINAL.has(state);

const RUN_TERMINAL = new Set(["succeeded", "partial", "failed", "canceled", "interrupted"]);
export const isTerminalRun = (run: Pick<RunState, "status">): boolean => RUN_TERMINAL.has(run.status);

/** A server block reason as the band's blocker. Model reasons name the node's model. */
export function blockerFromReason(reason: RunBlockReason, modelOf: () => ModelKey | null): NodeBlocker {
  const model = modelOf();
  switch (reason) {
    case "no_key":
      return model ? { kind: "no_key", model } : { kind: "model_unavailable", model: null };
    case "company_off":
      return model ? { kind: "company_off", model } : { kind: "model_unavailable", model: null };
    case "model_unavailable":
      return { kind: "model_unavailable", model };
    case "missing_input":
      return { kind: "missing_input", port: "" };
    case "missing_asset":
      return { kind: "missing_asset" };
    case "upstream_failed":
      return { kind: "upstream_failed", nodeId: "" };
  }
}

/** A result for settings that have changed since it was sent: kept, but marked (§0.11). */
const isLate = (node: RunNodeState, current: string | undefined) =>
  !!current && !isPendingFingerprint(current) && current !== node.fingerprint;

/** The runtime slice one node gets from a run frame. */
export function runtimeFor(
  run: RunState,
  node: RunNodeState,
  current: string | undefined,
  modelOf: () => ModelKey | null,
): Partial<NodeRuntime> {
  const base: Partial<NodeRuntime> = {
    runId: run.runId,
    state: node.state,
    jobSetIds: node.jobSetIds,
    done: node.done,
    total: node.total,
    error: node.error,
    blocker: node.blocked ? blockerFromReason(node.blocked, modelOf) : null,
    skipped: node.state === "cached",
    // The server's clock, so a reloaded tab carries on from where the run is.
    startedAt: node.startedAt ?? null,
    // A place in line only comes from the company's queue (job.queued). A node still waiting for
    // an earlier one in its run has no job there yet, so it just says it's waiting.
    position: null,
  };
  if (node.state === "done") base.late = isLate(node, current);
  if (!isTerminalNode(node.state)) base.late = false;
  if (isTerminalNode(node.state)) {
    base.progress = null;
    base.position = null;
    base.partialThumbUrl = null;
  }
  return base;
}

/**
 * What the document keeps for a finished node, or null when the document shouldn't change: the
 * server's own result (so every tab writes the same), marked late when the node's settings moved
 * on while it ran, so a reload still says "Made with older settings".
 */
export function resultFor(
  run: RunState,
  node: RunNodeState,
  current: string | undefined,
  now: string,
  previous: CanvasNodeResult | null = null,
): CanvasNodeResult | null {
  const result = resultOfRunNode(node, run.finishedAt ?? now, previous);
  if (!result) return null;
  return result.state === "done" && isLate(node, current) ? { ...result, late: true } : result;
}
