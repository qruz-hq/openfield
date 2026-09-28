import { CANVAS_RUN_MAX_JOBS, type CostEstimate } from "@openfield/core";
import type { NodeRegistry, NodeSpec } from "../nodes/registry";
import { ancestorsOf, incomingEdges, isLocked, topoOrder } from "../store/graph";
import type { DocSlice } from "../store/ops";
import { engineNode, isPendingFingerprint } from "./fingerprint";
import { STANDING_BLOCKERS } from "./inputs";
import type {
  CompiledNode,
  CompileResult,
  EngineContext,
  EngineNode,
  NodeBlocker,
  OutputValues,
  PortValue,
  ResolvedInputs,
} from "./types";

// One walk over the graph in dependency order: resolve each node's inputs from what its upstream
// nodes hand on, then ask its engine for a blocker and a compiled plan item. The run compiler and
// the live analysis (bands, ×k badges, run pill prices) both use it, so they can't disagree.
//
// A result is reusable only while it matches the node's settings (the fingerprint, §0.11) and the
// images it read: seedless models make new images under the same settings, so an earlier node that
// ran again, or runs in this pass at all, means new inputs here (§7.7).

export interface EvaluateInput {
  doc: DocSlice;
  registry: NodeRegistry;
  ctx: EngineContext;
  fingerprints: Readonly<Record<string, string>>;
  /** Runnable nodes that run in this pass. The others hand on the result they already have. */
  runs: (id: string) => boolean;
  /** Evaluate only these nodes. They must include everything upstream of them. Default: all. */
  only?: ReadonlySet<string>;
  /** ⌥-click: these run even when nothing changed. */
  bypass?: ReadonlySet<string>;
}

export interface NodeEvaluation {
  id: string;
  definition: NodeSpec | undefined;
  node: EngineNode;
  inputs: ResolvedInputs;
  outputs: OutputValues;
  runs: boolean;
  blocker: NodeBlocker | null;
  compiled: CompiledNode | null;
  /** What a run costs, also for a blocked node whose model is known (its faded pill still shows it). */
  estimate: CostEstimate | null;
  /** Its images match its settings, are all in the library, and can be reused in this pass. */
  fresh: boolean;
  /**
   * Its settings match, but the images it read aren't the ones coming in now, here or further up:
   * "Inputs changed". Unlike `fresh`, this doesn't care what else runs in the pass.
   */
  inputsChanged: boolean;
  /** Its images are all still in the library. */
  present: boolean;
  /** The saved result still matches, so the server will skip this node. */
  upToDate: boolean;
}

export interface Evaluation {
  order: string[];
  /** In a loop, or behind one. They never run. */
  cyclic: string[];
  nodes: Map<string, NodeEvaluation>;
}

/** The node has images and they were made with its current settings (the fingerprint alone). */
export function hasValidResult(node: EngineNode, fingerprint: string | undefined): boolean {
  const result = node.result;
  return (
    !!result &&
    result.assetIds.length > 0 &&
    (result.state === "done" || result.state === "cached") &&
    !!fingerprint &&
    !isPendingFingerprint(fingerprint) &&
    result.fingerprint === fingerprint
  );
}

const resultImages = (node: EngineNode): PortValue[] =>
  (node.result?.assetIds ?? []).map((assetId) => ({ kind: "asset" as const, assetId }));

/** Keeps only what a port of this type can take, so an odd saved edge can't feed text into images. */
function accepts(portType: string, value: PortValue): boolean {
  if (portType === "text") return value.kind === "text";
  if (portType === "image" || portType === "mask") return value.kind !== "text";
  return false;
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((id, i) => id === sorted[i]);
};

/** The model is known, so a plan (and its price) can be built even though something stops it. */
const priceable = (blocker: NodeBlocker) =>
  blocker.kind !== "model_unavailable" && blocker.kind !== "company_off";

export function evaluateGraph(input: EvaluateInput): Evaluation {
  const { doc, registry, ctx, fingerprints, runs, only, bypass } = input;
  const { order, cyclic } = topoOrder(doc, only);
  const loop = new Set(cyclic);
  const nodes = new Map<string, NodeEvaluation>();
  const missing = ctx.missing;

  const handedOn = (source: string, port: string): readonly PortValue[] => {
    const upstream = nodes.get(source);
    if (!upstream) return [];
    // A type this build doesn't know hands on whatever images it already made.
    if (!upstream.definition) return resultImages(upstream.node);
    return upstream.outputs[port] ?? [];
  };

  /**
   * The images a node reads, sorted. `inPass`: null while an earlier node that runs in this pass
   * still has to make them. Otherwise earlier nodes hand on the images they have now.
   */
  const imagesRead = (values: readonly PortValue[], inPass: boolean): string[] | null => {
    const ids = new Set<string>();
    for (const value of values) {
      if (value.kind === "asset") ids.add(value.assetId);
      else if (value.kind === "pending") {
        const upstream = nodes.get(value.nodeId);
        if (inPass && !upstream?.upToDate) return null;
        for (const assetId of upstream?.node.result?.assetIds ?? []) ids.add(assetId);
      }
    }
    return [...ids].sort();
  };

  for (const id of order) {
    const frame = doc.nodes[id];
    if (!frame || loop.has(id)) continue;
    const def = registry.get(frame.type);
    if (def?.annotation) continue;
    const node = engineNode(doc, id, registry, ctx);
    const fingerprint = fingerprints[id];

    const inputs: Record<string, PortValue[]> = {};
    for (const port of def?.ports ?? []) {
      if (port.direction !== "in" || port.hidden) continue;
      inputs[port.id] = incomingEdges(doc, id, port.id)
        .flatMap((edge) => handedOn(edge.source, edge.sourceHandle))
        .filter((value) => accepts(port.type, value));
    }

    const evaluation: NodeEvaluation = {
      id,
      definition: def,
      node,
      inputs,
      outputs: {},
      runs: false,
      blocker: null,
      compiled: null,
      estimate: null,
      fresh: false,
      inputsChanged: false,
      present: true,
      upToDate: false,
    };
    nodes.set(id, evaluation);
    if (!def?.engine) continue;
    const engine = def.engine;

    // A locked node never runs: it hands on the images it has, whatever its settings say now.
    const locked = isLocked(doc, id);
    if (!def.runnable || !runs(id) || locked) {
      evaluation.outputs = engine.outputs(node, inputs, ctx, false);
      // Its side sheet still prices a run, on the Run that waits for Unlock.
      if (locked && def.runnable && runs(id)) {
        try {
          const priced = engine.compile?.(node, inputs, ctx, fingerprint ?? "");
          if (priced?.ok) evaluation.estimate = priced.node.estimate;
        } catch {
          // Nothing to price until its settings would run.
        }
      }
      continue;
    }

    evaluation.runs = true;
    // The node's own key and model problems come first: they're what the person can fix here.
    let blocker: NodeBlocker | null = engine.blocker(node, inputs, ctx);
    if (!blocker || !STANDING_BLOCKERS.has(blocker.kind)) {
      const stuck = incomingEdges(doc, id).find((edge) => {
        const upstream = nodes.get(edge.source);
        return upstream?.runs && upstream.blocker;
      });
      if (stuck) blocker = { kind: "upstream_blocked", nodeId: stuck.source };
    }
    let compiled: CompileResult | undefined;
    if (!blocker || priceable(blocker)) {
      try {
        compiled = engine.compile?.(node, inputs, ctx, fingerprint ?? "");
      } catch (error) {
        // A blocked node is only priced when it can be; a node that can run must compile.
        if (!blocker) throw error;
      }
    }
    if (compiled?.ok) {
      evaluation.estimate = compiled.node.estimate;
      if (compiled.node.expectedJobs > CANVAS_RUN_MAX_JOBS) {
        blocker ??= { kind: "too_many_jobs", max: CANVAS_RUN_MAX_JOBS };
      } else if (!blocker) evaluation.compiled = compiled.node;
    } else if (compiled && !blocker) blocker = compiled.blocker;
    evaluation.blocker = blocker;

    const valid = hasValidResult(node, fingerprint);
    const values = Object.values(inputs).flat();
    const before = node.result?.inputs;
    const matches = (read: string[] | null) =>
      read !== null && (before === undefined || sameSet(before, read));
    const inputsMatch = matches(imagesRead(values, true));
    const upstreamChanged = values.some((v) => v.kind === "pending" && nodes.get(v.nodeId)?.inputsChanged);
    evaluation.present = !missing || (node.result?.assetIds ?? []).every((assetId) => !missing.has(assetId));
    evaluation.fresh = valid && inputsMatch && evaluation.present;
    evaluation.inputsChanged = valid && (upstreamChanged || !matches(imagesRead(values, false)));
    if (blocker || !evaluation.compiled) continue;

    const { cacheable } = engine.fingerprintParams(node, ctx);
    const item = evaluation.compiled.item;
    const bypassed = bypass?.has(id) ?? false;
    // Only a whole set made from what the node reads now is offered for reuse; a stopped one, or
    // one made from other images, runs again and the server never gets the chance to skip it.
    item.cached =
      cacheable && valid && inputsMatch && node.result?.fingerprint
        ? { fingerprint: node.result.fingerprint, assetIds: [...node.result.assetIds] }
        : null;
    if (bypassed) item.bypassCache = true;
    evaluation.upToDate = cacheable && evaluation.fresh && !bypassed;

    // Downstream nodes point at this one; they only need to know how many images to expect.
    const produced = engine.outputs(node, inputs, ctx, true);
    evaluation.outputs = evaluation.upToDate
      ? Object.fromEntries(
          Object.entries(produced).map(([port, values]) => [
            port,
            values.map((v) => (v.kind === "pending" ? { ...v, expected: node.result!.assetIds.length } : v)),
          ]),
        )
      : produced;
  }

  return { order, cyclic, nodes };
}

/** Runnable data nodes: the only ones a run can include. */
export function isRunnable(doc: DocSlice, registry: NodeRegistry, id: string): boolean {
  const frame = doc.nodes[id];
  const def = frame && registry.get(frame.type);
  return !!def && def.runnable && !def.annotation && !!def.engine?.compile;
}

/**
 * Runnable nodes upstream of `ids` whose images don't match their settings or what they read (or
 * who have none): the ones a single-node run has to run first. Locked nodes keep theirs.
 */
export function staleAncestors(
  doc: DocSlice,
  registry: NodeRegistry,
  ctx: EngineContext,
  fingerprints: Readonly<Record<string, string>>,
  ids: Iterable<string>,
): string[] {
  const ancestors = new Set<string>();
  for (const id of ids) for (const ancestor of ancestorsOf(doc, id)) ancestors.add(ancestor);
  if (!ancestors.size) return [];
  const evaluation = evaluateGraph({
    doc,
    registry,
    ctx,
    fingerprints,
    runs: (id) => isRunnable(doc, registry, id),
    only: ancestors,
  });
  const current = (id: string) => {
    const e = evaluation.nodes.get(id);
    return !!e && hasValidResult(e.node, fingerprints[id]) && !e.inputsChanged && e.present;
  };
  return doc.order.filter(
    (id) => ancestors.has(id) && isRunnable(doc, registry, id) && !isLocked(doc, id) && !current(id),
  );
}
