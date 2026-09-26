import type { CostEstimate } from "@openfield/core";
import type { NodeRegistry } from "../nodes/registry";
import type { DocSlice } from "../store/ops";
import { heldBack } from "./compile";
import { roundToCents, sumEstimates } from "./cost";
import { evaluateGraph, isRunnable } from "./evaluate";
import { imageCount, imagesOf, joinPrompt, textOf } from "./inputs";
import type { EngineContext, NodeBlocker } from "./types";

// The live read of the graph, redone after every change: what would stop each node, how many
// times it fans out and what a run of it costs. Nodes draw their bands, ×k badges and run pill
// prices from it; Run all shows the total. Unchanged entries keep their identity, so a node only
// re-renders when its own numbers move.

export interface NodeAnalysis {
  blocker: NodeBlocker | null;
  /** ×k: how many times an incoming list runs this node. */
  fanOut: number;
  /**
   * A run of this node alone, after fan-out, to the cent like Run all and the run preview, so the
   * node's Run and the top bar agree ("~$0.07 · Batch", design u0Hpn). Null when its model isn't known.
   */
  estimate: CostEstimate | null;
  jobs: number;
  /** Nothing changed since its images were made. */
  upToDate: boolean;
  /** Its settings match but the images coming in aren't the ones it used. */
  inputsChanged: boolean;
  /** It, or a node it reads from, is already running: a new run leaves it out for now. */
  held: boolean;
  /** The words coming in on its prompt input, joined ("From the Prompt node"). */
  upstreamText: string;
  /**
   * Reference images each request carries: every image on a multi input, one from a single input
   * (a list there fans out). A model for this node has to take at least this many.
   */
  references: number;
}

export interface GraphAnalysis {
  nodes: Readonly<Record<string, NodeAnalysis>>;
  /** Runnable nodes on the canvas that can run. With none, Run all is off. */
  runnable: number;
  /** What Run all would cost: nodes that would run, not the blocked, up-to-date or running ones. */
  estimate: CostEstimate;
  /** How many nodes Run all would actually run. */
  pending: number;
  /** Images Run all would make. Past CANVAS_RUN_MAX_JOBS it's off, since the server would refuse it. */
  jobs: number;
}

export const EMPTY_ANALYSIS: GraphAnalysis = {
  nodes: {},
  runnable: 0,
  estimate: sumEstimates([]),
  pending: 0,
  jobs: 0,
};

const LOOP_ANALYSIS: NodeAnalysis = {
  blocker: { kind: "loop" },
  fanOut: 1,
  estimate: null,
  jobs: 0,
  upToDate: false,
  inputsChanged: false,
  held: false,
  upstreamText: "",
  references: 0,
};

const sameEstimate = (a: CostEstimate | null, b: CostEstimate | null) =>
  a === b ||
  (!!a && !!b && a.min === b.min && a.max === b.max && a.confidence === b.confidence && a.basis === b.basis);

const sameNode = (a: NodeAnalysis, b: NodeAnalysis) =>
  a.upstreamText === b.upstreamText &&
  a.references === b.references &&
  a.fanOut === b.fanOut &&
  a.jobs === b.jobs &&
  a.upToDate === b.upToDate &&
  a.inputsChanged === b.inputsChanged &&
  a.held === b.held &&
  sameEstimate(a.estimate, b.estimate) &&
  JSON.stringify(a.blocker) === JSON.stringify(b.blocker);

export function analyzeGraph(
  doc: DocSlice,
  registry: NodeRegistry,
  ctx: EngineContext,
  fingerprints: Readonly<Record<string, string>>,
  previous: GraphAnalysis = EMPTY_ANALYSIS,
  /** Nodes queued or running right now. */
  busy: ReadonlySet<string> = new Set(),
): GraphAnalysis {
  const held = heldBack(doc, busy);
  const evaluation = evaluateGraph({
    doc,
    registry,
    ctx,
    fingerprints,
    runs: (id) => isRunnable(doc, registry, id),
  });

  const nodes: Record<string, NodeAnalysis> = {};
  const estimates: CostEstimate[] = [];
  let runnable = 0;
  let pending = 0;
  let jobs = 0;
  for (const [id, node] of evaluation.nodes) {
    if (!node.runs) continue;
    runnable++;
    const next: NodeAnalysis = {
      blocker: node.blocker,
      fanOut: node.compiled?.fanOut ?? 1,
      estimate: node.estimate && roundToCents(node.estimate),
      jobs: node.compiled?.expectedJobs ?? 0,
      upToDate: node.upToDate,
      inputsChanged: node.inputsChanged,
      held: held.has(id),
      upstreamText: joinPrompt(textOf(node.inputs, "prompt")),
      references: (node.definition?.ports ?? []).reduce((sum, port) => {
        if (port.direction !== "in" || port.binding?.to !== "references") return sum;
        const count = imageCount(imagesOf(node.inputs, port.id));
        return sum + (port.arity === "multi" ? count : Math.min(count, 1));
      }, 0),
    };
    const before = previous.nodes[id];
    nodes[id] = before && sameNode(before, next) ? before : next;
    if (node.compiled && !node.upToDate && !next.held) {
      pending++;
      jobs += node.compiled.expectedJobs;
      // Cent by cent, like the node pills and the run preview, so all three agree.
      estimates.push(roundToCents(node.compiled.estimate));
    }
  }
  // Loops (imports only) can't run: their band says so, and Run all leaves them out.
  for (const id of evaluation.cyclic) if (isRunnable(doc, registry, id)) nodes[id] = LOOP_ANALYSIS;

  const estimate = sumEstimates(estimates);
  const unchanged =
    runnable === previous.runnable &&
    pending === previous.pending &&
    jobs === previous.jobs &&
    sameEstimate(estimate, previous.estimate) &&
    Object.keys(nodes).length === Object.keys(previous.nodes).length &&
    Object.entries(nodes).every(([id, n]) => previous.nodes[id] === n);
  return unchanged ? previous : { nodes, runnable, estimate, pending, jobs };
}
