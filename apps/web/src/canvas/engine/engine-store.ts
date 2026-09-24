import type { CanvasRunResponse } from "@openfield/core";
import { create } from "zustand";
import { EMPTY_ANALYSIS, type GraphAnalysis, type NodeAnalysis } from "./analysis";
import { EMPTY_ENGINE_CONTEXT } from "./context-base";
import type { RunPreview } from "./preview";
import { isTerminalRun } from "./runtime";
import type { CompiledNode, EngineContext, RunState } from "./types";

// Engine state the canvas store doesn't hold: the live analysis nodes draw from, the runs this
// canvas has going, and the one confirmation that can be open. One open canvas at a time, so one
// store; CanvasEngine resets it when a canvas opens and closes.

/** The run preview (M4-18). With `upstream`, it also says which earlier nodes run first. */
export interface RunDialog {
  kind: "preview";
  preview: RunPreview;
  response: CanvasRunResponse;
  items: readonly CompiledNode[];
  /** A single-node run that has to run these earlier nodes too: "Run them too". */
  upstream: readonly string[] | null;
  anchor: Element | null;
  resolve: (run: boolean) => void;
}

interface EngineState {
  /** Models and defaults, shared so every node doesn't query them itself. */
  ctx: EngineContext;
  analysis: GraphAnalysis;
  /** Latest state of each run started or seen on this canvas, by run id. */
  runs: Readonly<Record<string, RunState>>;
  dialog: RunDialog | null;
  /** A run is being compiled or posted: run buttons wait. */
  starting: boolean;
  setContext(ctx: EngineContext): void;
  setAnalysis(analysis: GraphAnalysis): void;
  putRun(run: RunState): void;
  openDialog(dialog: RunDialog): void;
  /** Answers the open confirmation and closes it. */
  answer(yes: boolean): void;
  setStarting(starting: boolean): void;
  /** Closes the open confirmation (answered no) and stops waiting on a run. */
  withdraw(): void;
  reset(): void;
}

export const useEngineStore = create<EngineState>((set, get) => ({
  ctx: EMPTY_ENGINE_CONTEXT,
  analysis: EMPTY_ANALYSIS,
  runs: {},
  dialog: null,
  starting: false,
  setContext: (ctx) => set({ ctx }),
  setAnalysis: (analysis) => {
    if (analysis !== get().analysis) set({ analysis });
  },
  putRun: (run) => set({ runs: { ...get().runs, [run.runId]: run } }),
  openDialog: (dialog) => {
    // Only one question at a time: a new one withdraws the old.
    get().dialog?.resolve(false);
    set({ dialog });
  },
  answer: (yes) => {
    const dialog = get().dialog;
    set({ dialog: null });
    dialog?.resolve(yes);
  },
  setStarting: (starting) => set({ starting }),
  withdraw: () => {
    get().dialog?.resolve(false);
    set({ dialog: null, starting: false });
  },
  reset: () => {
    get().dialog?.resolve(false);
    set({ analysis: EMPTY_ANALYSIS, runs: {}, dialog: null, starting: false });
  },
}));

export const useNodeAnalysis = (id: string): NodeAnalysis | undefined =>
  useEngineStore((s) => s.analysis.nodes[id]);

/** The engine context CanvasEngine keeps current. Cheap to read from every node. */
export const useCanvasEngineContext = (): EngineContext => useEngineStore((s) => s.ctx);

/** Runs that haven't finished yet. */
export const activeRuns = (runs: Readonly<Record<string, RunState>>): RunState[] =>
  Object.values(runs).filter((run) => !isTerminalRun(run));
