import type { CanvasRunScope } from "@openfield/core";

// The run controller: installed on the store by the engine, called by the editor and the nodes.
// Browser-only (a confirmation anchors to the button that was pressed), so it stays out of
// @openfield/canvas.

export interface RunRequest {
  scope: CanvasRunScope;
  /** node and downstream: one id. selection: the selected ids. all: ignored. */
  nodeIds: readonly string[];
  bypassCache?: boolean;
  /** Where a confirmation opens: the pressed run pill or button. Defaults to the node's pill or Run all. */
  anchor?: Element | null;
}

export interface RunController {
  /** False until the engine has mounted. Run buttons stay disabled until then. */
  readonly ready: boolean;
  /** Compiles, asks when it has to (earlier nodes, run-all preview, over 32 jobs), then posts. */
  run(request: RunRequest): Promise<void>;
  /** Top bar Stop: cancels every active run on this canvas. */
  stop(): Promise<void>;
  /** A node band's Cancel: that node's job sets only. */
  cancelNode(nodeId: string): Promise<void>;
}

export const NOOP_RUN_CONTROLLER: RunController = {
  ready: false,
  run: async () => {},
  stop: async () => {},
  cancelNode: async () => {},
};
