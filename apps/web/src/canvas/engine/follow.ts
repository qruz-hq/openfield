import type { ModelKey, SseEvent } from "@openfield/core";
import type { CanvasNodeResult } from "@openfield/core/canvas";
import type { NodeRegistry } from "../nodes/registry";
import { descendantsOf } from "../store/graph";
import type { CanvasOp } from "../store/ops";
import type { CanvasStore } from "../store/store";
import { RUN_ONLY_BLOCKERS } from "./display";
import { useEngineStore } from "./engine-store";
import { engineNode } from "./fingerprint";
import { modelKeyOf } from "./inputs";
import { isTerminalNode, resultFor, runtimeFor } from "./runtime";
import type { EngineContext, NodeRuntime, RunState } from "./types";

// Following runs: canvas_run.updated frames (and GET …/runs on open) set each node's live state
// and, once a node finishes, write its result into the document. The server has already written the
// same result into the saved canvas, so every open tab ends up with the same copy. job.* frames add
// what the run frame doesn't carry: the company's queue position, progress and partial previews.

export interface Follower {
  /** A run state from the stream, a run response or the runs list. */
  applyRun(run: RunState, opts?: { live?: boolean }): void;
  /** Any frame from the stream. */
  applyEvent(event: SseEvent): void;
}

export interface FollowerDeps {
  store: CanvasStore;
  registry: NodeRegistry;
  context: () => EngineContext;
  /** A node finished while the canvas was open (not on a catch-up after load). */
  onFinished?: (nodeId: string) => void;
}

const FRESH_RUN: Partial<NodeRuntime> = {
  startedAt: null,
  progress: null,
  position: null,
  partialThumbUrl: null,
};

const sameResult = (a: CanvasNodeResult | null | undefined, b: CanvasNodeResult) =>
  !!a &&
  a.state === b.state &&
  a.fingerprint === b.fingerprint &&
  a.assetIds.length === b.assetIds.length &&
  a.assetIds.every((id, i) => id === b.assetIds[i]);

export function createFollower({ store, registry, context, onFinished }: FollowerDeps): Follower {
  /** (run, node) pairs whose result is already in the document. */
  const written = new Set<string>();
  /** Progress per job, so a node's bar covers all its jobs. */
  const progress = new Map<string, Map<string, number>>();
  /** The company's own queue position, from job.queued. */
  const queued = new Map<string, number>();

  const nodeOfJobSet = (jobSetId: string): string | undefined => {
    const { runtime } = store.getState();
    for (const [nodeId, r] of Object.entries(runtime)) if (r.jobSetIds.includes(jobSetId)) return nodeId;
    return undefined;
  };

  const applyRun: Follower["applyRun"] = (run, { live = true } = {}) => {
    const state = store.getState();
    if (run.canvasId !== state.canvasId) return;
    const runs = useEngineStore.getState().runs;
    const previous = runs[run.runId];
    // Frames are whole snapshots; an older one arriving late would roll the state back.
    if (
      previous?.nodes.every((n) => isTerminalNode(n.state)) &&
      !run.nodes.every((n) => isTerminalNode(n.state))
    )
      return;
    useEngineStore.getState().putRun(run);

    const ctx = context();
    const patches: Record<string, Partial<NodeRuntime>> = {};
    const ops: CanvasOp[] = [];
    const finished: string[] = [];
    const now = new Date().toISOString();
    for (const node of run.nodes) {
      const id = node.nodeId;
      if (!state.doc.nodes[id]) continue;
      // A newer run took this node over; this one's frames no longer speak for it.
      const owner = state.runtime[id]?.runId;
      if (owner && owner !== run.runId && runs[owner] && runs[owner]!.createdAt > run.createdAt) continue;

      const modelOf = () => {
        const params = engineNode(state.doc, id, registry, ctx).params as { model?: ModelKey };
        return modelKeyOf(params.model, ctx);
      };
      // The first frame of a new run can beat the run response here, so it clears what the last
      // run left behind (its bar and queue spot) itself.
      const fresh = state.runtime[id]?.runId !== run.runId;
      const patch: Partial<NodeRuntime> = {
        ...(fresh && FRESH_RUN),
        ...runtimeFor(run, node, state.fingerprints[id], modelOf),
      };
      const own = queued.get(id);
      if (node.state === "queued" && own) patch.position = own;
      // Before the server has a start time, the clock starts when the tab first sees it running.
      if (node.state === "running" && !patch.startedAt)
        patch.startedAt = (!fresh && state.runtime[id]?.startedAt) || now;
      patches[id] = patch;
      if (!isTerminalNode(node.state)) continue;
      progress.delete(id);
      queued.delete(id);

      const key = `${run.runId}:${id}`;
      if (written.has(key)) continue;
      written.add(key);
      const result = resultFor(run, node, state.fingerprints[id], now, state.doc.results[id] ?? null);
      if (result && !sameResult(state.doc.results[id], result)) ops.push({ op: "setResult", id, result });
      if (node.state === "done" && live) finished.push(id);
    }

    // An earlier node that now has its images clears "An earlier node failed" below it, when an
    // older run said so: a reload would show no band there either (§7.5).
    const ready = run.nodes.filter((n) => n.state === "done" || n.state === "cached").map((n) => n.nodeId);
    for (const id of ready) {
      if (!state.doc.nodes[id]) continue;
      for (const below of descendantsOf(state.doc, id)) {
        const r = state.runtime[below];
        if (patches[below] || !r || r.runId === run.runId || r.state !== "blocked") continue;
        if (!r.blocker || !RUN_ONLY_BLOCKERS.has(r.blocker.kind)) continue;
        const older = !r.runId || !runs[r.runId] || runs[r.runId]!.createdAt <= run.createdAt;
        if (older) patches[below] = { state: "idle", blocker: null, runId: null, jobSetIds: [] };
      }
    }

    state.actions.setRuntime(patches);
    if (ops.length) {
      // One undo entry per run: undo clears the results, the images stay in the library (§7.8). A
      // result landing never wipes the redo stack, so an undo made during the run can be redone.
      state.actions.apply(
        ops,
        live
          ? { label: "run", coalesce: `run:${run.runId}`, coalesceMs: Infinity, keepRedo: true }
          : { history: false },
      );
    }
    for (const id of finished) onFinished?.(id);
  };

  const applyEvent: Follower["applyEvent"] = (event) => {
    switch (event.event) {
      case "canvas_run.updated":
        applyRun(event.data);
        return;
      case "job.queued": {
        const nodeId = nodeOfJobSet(event.data.jobSetId);
        if (!nodeId || !event.data.position) return;
        queued.set(nodeId, event.data.position);
        store.getState().actions.setRuntime({ [nodeId]: { position: event.data.position } });
        return;
      }
      case "job.started": {
        const nodeId = nodeOfJobSet(event.data.jobSetId);
        if (!nodeId) return;
        queued.delete(nodeId);
        const current = store.getState().runtime[nodeId];
        store.getState().actions.setRuntime({
          [nodeId]: {
            state: "running",
            position: null,
            startedAt: current?.startedAt ?? event.data.startedAt,
          },
        });
        return;
      }
      case "job.progress": {
        const nodeId = nodeOfJobSet(event.data.jobSetId);
        if (!nodeId) return;
        const jobs = progress.get(nodeId) ?? new Map<string, number>();
        jobs.set(event.data.jobId, event.data.progress);
        progress.set(nodeId, jobs);
        const total = Math.max(store.getState().runtime[nodeId]?.total ?? 1, jobs.size, 1);
        const sum = [...jobs.values()].reduce((a, b) => a + b, 0);
        store.getState().actions.setRuntime({ [nodeId]: { progress: Math.min(1, sum / total) } });
        return;
      }
      case "job.partial": {
        const nodeId = nodeOfJobSet(event.data.jobSetId);
        if (nodeId)
          store.getState().actions.setRuntime({ [nodeId]: { partialThumbUrl: event.data.thumbUrl } });
        return;
      }
      default:
        return;
    }
  };

  return { applyRun, applyEvent };
}
