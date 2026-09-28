import type { CanvasRunScope, CostEstimate } from "@openfield/core";
import type { NodeRegistry } from "../nodes/registry";
import { ancestorsOf, descendantsOf, isLocked, topoOrder } from "../store/graph";
import type { DocSlice } from "../store/ops";
import { sumEstimates } from "./cost";
import { evaluateGraph, isRunnable, staleAncestors } from "./evaluate";
import type { CompiledNode, EngineContext, NodeBlocker } from "./types";

// The DAG compiler (§7.7): picks the nodes a scope covers, adds what they need, and turns each
// into a plan item in dependency order. Blocked nodes stay out of the plan and are reported, and so
// is everything that depends on them. Nodes already queued or running stay out too, with what reads
// from them: sending them again would pay for the same work twice. Locked nodes never run: a scope
// leaves them out and the nodes after them read the images they keep.

export interface CompileRequest {
  scope: CanvasRunScope;
  nodeIds: readonly string[];
  bypassCache?: boolean;
  /** "Run them too": a single-node run also runs the earlier nodes it needs. */
  includeUpstream?: boolean;
}

export type CompileOutcome =
  /** Everything asked for is in a loop, or below one (only an import can do that). Nothing runs. */
  | { kind: "cycle" }
  /** Everything the scope covers is already running, or waits on something that is. */
  | { kind: "busy"; upstream: boolean }
  /** A single-node run whose earlier nodes have to run first. Ask, then compile again. */
  | { kind: "needs_upstream"; nodeIds: string[] }
  /** Everything the scope covers is locked, so nothing runs. */
  | { kind: "locked"; nodeIds: string[] }
  | {
      kind: "plan";
      /** Plan items in dependency order, ready to post. */
      items: CompiledNode[];
      /** Items the server should skip because nothing changed. */
      upToDate: string[];
      /** Nodes the scope covers that stay out because they're locked. */
      locked: string[];
      blocked: Record<string, NodeBlocker>;
      /** Jobs for the items that will actually run, after fan-out. */
      jobs: number;
      /** Local estimate for the same items. */
      estimate: CostEstimate;
    };

export interface CompileInput {
  doc: DocSlice;
  registry: NodeRegistry;
  ctx: EngineContext;
  fingerprints: Readonly<Record<string, string>>;
  request: CompileRequest;
  /** Nodes queued or running right now. */
  busy?: ReadonlySet<string>;
}

/** Nodes a new run leaves alone: those in flight, and everything below them (their inputs are coming). */
export function heldBack(doc: DocSlice, busy: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  for (const id of busy) {
    if (!doc.nodes[id] || held.has(id)) continue;
    held.add(id);
    for (const below of descendantsOf(doc, id)) held.add(below);
  }
  return held;
}

/** The runnable nodes a scope asks for, before anything upstream is added. Locked ones stay out. */
export function scopeTargets(doc: DocSlice, registry: NodeRegistry, request: CompileRequest): string[] {
  return scopeNodes(doc, registry, request).filter((id) => !isLocked(doc, id));
}

/** The runnable nodes a scope covers that are locked: they keep their images and don't run. */
export function lockedInScope(doc: DocSlice, registry: NodeRegistry, request: CompileRequest): string[] {
  return scopeNodes(doc, registry, request).filter((id) => isLocked(doc, id));
}

function scopeNodes(doc: DocSlice, registry: NodeRegistry, request: CompileRequest): string[] {
  const runnable = (id: string) => isRunnable(doc, registry, id);
  switch (request.scope) {
    case "node":
      return request.nodeIds.slice(0, 1).filter(runnable);
    case "downstream": {
      const start = request.nodeIds[0];
      if (!start || !doc.nodes[start]) return [];
      const below = descendantsOf(doc, start);
      return doc.order.filter((id) => (id === start || below.has(id)) && runnable(id));
    }
    case "all":
      return doc.order.filter(runnable);
    case "selection":
      return doc.order.filter((id) => request.nodeIds.includes(id) && runnable(id));
  }
}

export function compileRun({
  doc,
  registry,
  ctx,
  fingerprints,
  request,
  busy = new Set(),
}: CompileInput): CompileOutcome {
  const held = heldBack(doc, busy);
  const asked = scopeTargets(doc, registry, request);
  const locked = lockedInScope(doc, registry, request);
  if (!asked.length && locked.length) return { kind: "locked", nodeIds: locked };
  const targets = new Set(asked.filter((id) => !held.has(id)));
  if (asked.length && !targets.size) {
    return { kind: "busy", upstream: asked.every((id) => !busy.has(id)) };
  }
  const needed = staleAncestors(doc, registry, ctx, fingerprints, targets).filter((id) => !targets.has(id));
  if (request.scope === "node" && needed.length && !request.includeUpstream) {
    return { kind: "needs_upstream", nodeIds: needed };
  }
  for (const id of needed) targets.add(id);

  // Nodes in a loop, or below one, stay out and say so; the rest of the canvas still runs. The
  // ancestors of a node outside any loop are outside every loop too, so what's left is acyclic.
  const blocked: Record<string, NodeBlocker> = {};
  const withAncestors = (ids: Iterable<string>) => {
    const all = new Set(ids);
    for (const id of [...all]) for (const ancestor of ancestorsOf(doc, id)) all.add(ancestor);
    return all;
  };
  let relevant = withAncestors(targets);
  const { cyclic } = topoOrder(doc, relevant);
  if (cyclic.length) {
    for (const id of cyclic) {
      if (!targets.delete(id)) continue;
      blocked[id] = { kind: "loop" };
    }
    if (!targets.size) return { kind: "cycle" };
    relevant = withAncestors(targets);
  }

  // ⌥ reruns what was asked for; everything below it follows, since its inputs change.
  const bypass = new Set(request.bypassCache ? (request.scope === "node" ? asked : [...targets]) : []);
  const evaluation = evaluateGraph({
    doc,
    registry,
    ctx,
    fingerprints,
    runs: (id) => targets.has(id),
    only: relevant,
    bypass,
  });

  const items: CompiledNode[] = [];
  const upToDate: string[] = [];
  let jobs = 0;
  const estimates: CostEstimate[] = [];
  for (const id of evaluation.order) {
    const node = evaluation.nodes.get(id);
    if (!node?.runs) continue;
    if (node.blocker) {
      blocked[id] = node.blocker;
      continue;
    }
    if (!node.compiled) continue;
    items.push(node.compiled);
    if (node.upToDate) upToDate.push(id);
    else {
      jobs += node.compiled.expectedJobs;
      estimates.push(node.compiled.estimate);
    }
  }
  return { kind: "plan", items, upToDate, locked, blocked, jobs, estimate: sumEstimates(estimates) };
}
