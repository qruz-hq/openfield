import {
  CANVAS_CONFIRM_JOBS,
  CANVAS_RUN_MAX_JOBS,
  type CanvasRunBody,
  type CanvasRunResponse,
  t,
} from "@openfield/core";
import { ApiError, errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import type { NodeRegistry } from "../nodes/registry";
import type { CanvasStore } from "../store/store";
import { type CompileOutcome, compileRun } from "./compile";
import { activeRuns, useEngineStore } from "./engine-store";
import { buildPreview } from "./preview";
import { blockerFromReason } from "./runtime";
import type { CompiledNode, EngineContext, NodeRuntime, RunController, RunRequest } from "./types";

// The run controller (§7.7): compile, ask when it has to, post, and seed the node states until
// the first canvas_run.updated frame lands. Installed on the store by CanvasEngine; the editor's
// shortcuts and every run button go through it.

export interface RunApi {
  post(canvasId: string, body: CanvasRunBody): Promise<CanvasRunResponse>;
  cancelRun(canvasId: string, runId: string): Promise<unknown>;
  cancelNode(canvasId: string, runId: string, nodeId: string): Promise<unknown>;
}

export interface RunControllerDeps {
  store: CanvasStore;
  registry: NodeRegistry;
  context: () => EngineContext;
  /** Every fingerprint, fully hashed. */
  fingerprints: () => Promise<Record<string, string>>;
  /**
   * Settings → Spending's monthly limit, null when off. Once this month's spend, plus what a run
   * could cost, reaches it, every run asks first, even a single node (§6.9, §7.7).
   */
  spendGuard: () => number | null;
  /** Spent this month so far, as this computer tracked it. */
  spentThisMonth?: () => Promise<number>;
  api: RunApi;
}

const ACTIVE = new Set<NodeRuntime["state"]>(["queued", "running"]);

/** Nodes waiting or working in a run right now. */
export const busyNodes = (runtime: Readonly<Record<string, NodeRuntime>>): Set<string> =>
  new Set(Object.entries(runtime).flatMap(([id, r]) => (ACTIVE.has(r.state) ? [id] : [])));

/** Where a confirmation opens when the caller didn't say: the node's pill, else Run all. */
function defaultAnchor(request: RunRequest): Element | null {
  if (request.anchor) return request.anchor;
  if (typeof document === "undefined") return null;
  const id = request.nodeIds[0];
  const pill =
    id && request.scope !== "all" ? document.querySelector(`[data-run-pill="${CSS.escape(id)}"]`) : null;
  return pill ?? document.querySelector("[data-run-all]");
}

export function createRunController(deps: RunControllerDeps): RunController {
  const { store, registry, context, api } = deps;
  const engine = useEngineStore.getState;

  const askPreview = (
    response: CanvasRunResponse,
    items: CompiledNode[],
    anchor: Element | null,
    upstream: string[] | null,
  ) =>
    new Promise<boolean>((resolve) =>
      engine().openDialog({
        kind: "preview",
        preview: buildPreview(response),
        response,
        items,
        upstream,
        anchor,
        resolve,
      }),
    );

  async function compile(request: RunRequest, includeUpstream = false): Promise<CompileOutcome> {
    const fingerprints = await deps.fingerprints();
    const state = store.getState();
    return compileRun({
      doc: state.doc,
      registry,
      ctx: context(),
      fingerprints,
      busy: busyNodes(state.runtime),
      request: {
        scope: request.scope,
        nodeIds: request.nodeIds,
        bypassCache: request.bypassCache,
        includeUpstream,
      },
    });
  }

  /** Seeds node states from the response; canvas_run.updated takes over from here. */
  function seed(response: CanvasRunResponse) {
    if (!response.runId) return;
    const { runtime } = store.getState();
    const patches: Record<string, Partial<NodeRuntime>> = {};
    const base = (): Partial<NodeRuntime> => ({
      runId: response.runId,
      error: null,
      blocker: null,
      skipped: false,
      late: false,
      progress: null,
      position: null,
      partialThumbUrl: null,
      startedAt: null,
      done: 0,
    });
    for (const node of response.nodes) {
      // The stream may already be ahead of this response.
      if (runtime[node.nodeId]?.runId === response.runId) continue;
      const jobSetIds = response.jobSets.filter((j) => j.nodeId === node.nodeId).map((j) => j.jobSetId);
      patches[node.nodeId] = node.skipped
        ? { ...base(), state: "cached", skipped: true, jobSetIds: [], total: 0 }
        : node.blocked
          ? {
              ...base(),
              state: "blocked",
              jobSetIds: [],
              total: 0,
              blocker: blockerFromReason(node.blocked, () => null),
            }
          : { ...base(), state: "queued", jobSetIds, total: node.jobs };
    }
    store.getState().actions.setRuntime(patches);
  }

  async function run(request: RunRequest): Promise<void> {
    const state = store.getState();
    if (state.ui.readOnly || engine().starting) return;
    const anchor = defaultAnchor(request);
    engine().setStarting(true);
    try {
      let outcome = await compile(request);
      // Earlier nodes that have to run first are asked about in the preview itself, with their prices.
      let upstream: string[] | null = null;
      if (outcome.kind === "needs_upstream") {
        upstream = outcome.nodeIds;
        outcome = await compile(request, true);
      }
      if (outcome.kind === "busy") {
        const single = request.scope === "node";
        notify(
          single && !outcome.upstream
            ? t("canvas.run.busy")
            : single
              ? t("canvas.run.busyUpstream")
              : t("canvas.run.allBusy"),
        );
        return;
      }
      if (outcome.kind === "cycle") {
        notifyError(t("canvas.run.loop"));
        return;
      }
      if (outcome.kind !== "plan") return;

      // Show why nodes can't run on the nodes themselves.
      const blocked = Object.entries(outcome.blocked);
      if (blocked.length) {
        store
          .getState()
          .actions.setRuntime(
            Object.fromEntries(
              blocked.map(([id, blocker]) => [id, { state: "blocked", blocker, runId: null, jobSetIds: [] }]),
            ),
          );
      }
      if (!outcome.items.length) {
        // A single node's band already says why; a wider run can leave several marked.
        if (blocked.length && request.scope !== "node") notify(t("canvas.run.nothing"));
        return;
      }
      // The server refuses these before building anything; say so here, before a price is shown.
      if (outcome.jobs > CANVAS_RUN_MAX_JOBS) {
        notifyError(t("canvas.errors.tooManyJobs", { max: CANVAS_RUN_MAX_JOBS }));
        return;
      }

      const canvasId = store.getState().canvasId;
      const body: CanvasRunBody = {
        scope: request.scope,
        nodeIds: request.scope === "all" ? [] : [...request.nodeIds],
        plan: outcome.items.map((c) => c.item),
      };
      const guard = deps.spendGuard();
      // Only looked up when a limit is set. An unknown price counts as nothing on top.
      const spent = guard !== null ? await (deps.spentThisMonth?.() ?? Promise.resolve(0)).catch(() => 0) : 0;
      const overGuard = (estimate: CanvasRunResponse["estimate"]) =>
        guard !== null && spent + (estimate.confidence === "unknown" ? 0 : estimate.max) >= guard;
      const willRun = outcome.items.length - outcome.upToDate.length;
      let ask =
        upstream !== null ||
        (outcome.items.length > 1 && willRun > 0) ||
        outcome.jobs > CANVAS_CONFIRM_JOBS ||
        overGuard(outcome.estimate);

      // The server has the last word on what's reusable (an image file may have gone missing), so
      // a plan that offers anything for reuse asks it first, and a run bigger than this one thinks
      // shows the preview before anything is spent.
      let dry: CanvasRunResponse | null = null;
      if (ask || outcome.upToDate.length > 0) {
        dry = await api.post(canvasId, { ...body, dryRun: true });
        const running = dry.nodes.filter((n) => !n.skipped && !n.blocked).length;
        ask ||=
          dry.jobs > outcome.jobs ||
          dry.jobs > CANVAS_CONFIRM_JOBS ||
          overGuard(dry.estimate) ||
          (running > 1 && dry.jobs > 0);
        if (ask && !(await askPreview(dry, outcome.items, anchor, upstream))) return;
      }
      const confirmed = !!dry && dry.jobs > CANVAS_CONFIRM_JOBS;

      let response: CanvasRunResponse;
      try {
        response = await api.post(canvasId, { ...body, ...(confirmed && { confirmed: true }) });
      } catch (error) {
        // The server counted more than 32 images after all: show what it counted, then ask.
        if (!(error instanceof ApiError && error.code === "conflict" && error.field === "confirmed"))
          throw error;
        const recount = await api.post(canvasId, { ...body, dryRun: true });
        if (!(await askPreview(recount, outcome.items, anchor, upstream))) return;
        response = await api.post(canvasId, { ...body, confirmed: true });
      }
      seed(response);
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      engine().setStarting(false);
    }
  }

  async function stop(): Promise<void> {
    const { canvasId } = store.getState();
    const runs = activeRuns(engine().runs).filter((r) => r.canvasId === canvasId);
    const results = await Promise.allSettled(runs.map((r) => api.cancelRun(canvasId, r.runId)));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) notifyError(errorMessage((failed as PromiseRejectedResult).reason));
    else if (runs.length) notify(t("toast.canceled"));
  }

  /** A node's Cancel: that node and what reads from it, never the rest of its run (§7.7). */
  async function cancelNode(nodeId: string): Promise<void> {
    const { canvasId, runtime } = store.getState();
    const runId = runtime[nodeId]?.runId;
    if (!runId) return;
    try {
      await api.cancelNode(canvasId, runId, nodeId);
    } catch (error) {
      notifyError(errorMessage(error));
    }
  }

  return { ready: true, run, stop, cancelNode };
}
