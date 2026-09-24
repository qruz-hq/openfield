import type { CostEstimate } from "@openfield/core";
import { roundToCents, sumEstimates, UNKNOWN_COST, ZERO_COST } from "./cost";
import type { RunNodeSummary } from "./types";

// The run preview (M4-18, design qlYUt): one row per node that runs, one row for everything up
// to date, and a total that is the sum of the rows as shown. Unknown prices get their own rows,
// stay out of the total and are named under it.

export type PreviewRow =
  | { kind: "run"; nodeId: string; jobs: number; estimate: CostEstimate }
  | { kind: "unknown"; nodeId: string; jobs: number }
  | { kind: "up_to_date"; nodeIds: string[] };

export interface RunPreview {
  rows: PreviewRow[];
  /** Nodes that will make images. */
  running: number;
  images: number;
  /** The rows added up, cent by cent. */
  total: CostEstimate;
  /** Nodes whose price nobody publishes. */
  unknown: string[];
}

export function buildPreview(response: { jobs: number; nodes: readonly RunNodeSummary[] }): RunPreview {
  const priced: PreviewRow[] = [];
  const unknownRows: PreviewRow[] = [];
  const upToDate: string[] = [];
  for (const node of response.nodes) {
    if (node.blocked) continue;
    if (node.skipped) upToDate.push(node.nodeId);
    else if (node.estimate.confidence === "unknown")
      unknownRows.push({ kind: "unknown", nodeId: node.nodeId, jobs: node.jobs });
    else
      priced.push({
        kind: "run",
        nodeId: node.nodeId,
        jobs: node.jobs,
        estimate: roundToCents(node.estimate),
      });
  }
  const rows = [
    ...priced,
    ...(upToDate.length ? [{ kind: "up_to_date" as const, nodeIds: upToDate }] : []),
    ...unknownRows,
  ];
  const known = priced.flatMap((row) => (row.kind === "run" ? [row.estimate] : []));
  const unknown = unknownRows.map((row) => (row as { nodeId: string }).nodeId);
  return {
    rows,
    running: priced.length + unknownRows.length,
    images: response.jobs,
    // Only unknown rows: the total is unknown too. Only up to date: it's free.
    total: known.length ? sumEstimates(known) : unknown.length ? UNKNOWN_COST : ZERO_COST,
    unknown,
  };
}
