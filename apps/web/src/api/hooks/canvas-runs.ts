import type { CanvasRunBody, CanvasRunResponse, CanvasRunState } from "@openfield/core";
import { api, call } from "../client";

// Canvas runs (§7.7, §8.3). Plain calls, not queries: the engine owns the run state, which lives in
// the canvas store and arrives on canvas_run.updated.

/** POST /api/canvases/:id/run. A dry run answers with the estimate and what would be skipped. */
export function postCanvasRun(canvasId: string, body: CanvasRunBody): Promise<CanvasRunResponse> {
  return call(api.api.canvases[":id"].run.$post({ param: { id: canvasId }, json: body }));
}

/** Top bar Stop: every job set of the run, and whatever hasn't started yet. */
export function cancelCanvasRun(canvasId: string, runId: string) {
  return call(api.api.canvases[":id"].runs[":runId"].cancel.$post({ param: { id: canvasId, runId } }));
}

/** Runs still going, plus runs that finished after `since`: what a tab that opened late missed. */
export async function listCanvasRuns(canvasId: string, since?: string): Promise<CanvasRunState[]> {
  const res = await call(
    api.api.canvases[":id"].runs.$get({ param: { id: canvasId }, query: since ? { since } : {} }),
  );
  return res.runs;
}

/** A node band's Cancel: that node and what reads from it; the rest of the run carries on. */
export function cancelCanvasNode(canvasId: string, runId: string, nodeId: string) {
  return call(
    api.api.canvases[":id"].runs[":runId"].nodes[":nodeId"].cancel.$post({
      param: { id: canvasId, runId, nodeId },
    }),
  );
}
