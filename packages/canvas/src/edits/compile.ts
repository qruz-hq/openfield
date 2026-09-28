import { canonicalJson, type MessageKey, type MessageVars, t } from "@openfield/core";
import { type CanvasEdge, type CanvasEdit, type CanvasViewport, localIdSchema } from "@openfield/core/canvas";
import { type ConnectionEnds, checkConnection } from "../engine/connect";
import { nodeTitle } from "../engine/describe";
import { type EngineContext, isAnnotationHandle, type PortSpec, portFlow } from "../engine/types";
import type { ImageSizes, NodeRegistry, NodeSpec } from "../nodes/registry";
import { absolutePosition, containedIn, incomingEdges, newEdgeId, newNodeId } from "../store/graph";
import { applyOps, type CanvasOp, CanvasOpError, type DocSlice, type Point } from "../store/ops";
import { fitFrames } from "./frames";
import { type BoxSource, framesAround, nearestFree, nodeRect, overlaps, placeNode, type Rect } from "./place";

// Edits (§7.11): what an agent or a script asks for, compiled into the editor's own document ops,
// which the server applies and every open tab replays. Each edit is checked against the canvas as the
// edits before it left it, with the editor's rules: ports and loops (checkConnection), node types
// and their settings (the specs), frames. Any edit that doesn't fit stops the whole batch.
// Nodes count at their real box (place.ts): new ones go where they fit, a position given by hand
// that lands on another node moves to the nearest free spot (unless `exact`), and every frame the
// edits reached grows to hold what's in it (frames.ts).

export type EditErrorCode =
  | "no_node"
  | "no_edge"
  | "not_supported"
  | "bad_param"
  | "bad_model"
  | "not_frame"
  | "bad_alias"
  | "cant_connect"
  | "bad_edit";

/** One edit didn't fit. `message` says why in words the person (or the agent) can act on. */
export class EditError extends Error {
  constructor(
    readonly index: number,
    readonly code: EditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditError";
  }
}

export interface CompileEditsOptions {
  specs: NodeRegistry;
  ctx: EngineContext;
  /** The saved viewport: the first node of an empty canvas goes where the person last looked. */
  viewport?: CanvasViewport;
  /** The library's image sizes, so an image card counts at the shape of its image. */
  images?: ImageSizes;
  /** Tests pass their own. */
  newNodeId?: () => string;
  newEdgeId?: () => string;
}

export interface CompiledEdits {
  ops: CanvasOp[];
  /** The document after the ops. */
  doc: DocSlice;
  /** Nodes added or changed, in the order the edits reached them. */
  touched: string[];
  /** Each `as` name, with the id its node got. */
  aliases: Record<string, string>;
  /** Where the result differs from what was asked, and why: "Nudged Key visual 120px right to clear Prompt." */
  notes: string[];
}

const DEFAULT_ARROW = { source: "arrow-source-right", target: "arrow-target-left" };

export function compileEdits(
  base: DocSlice,
  edits: readonly CanvasEdit[],
  opts: CompileEditsOptions,
): CompiledEdits {
  const { specs, ctx } = opts;
  const nextNodeId = opts.newNodeId ?? newNodeId;
  const nextEdgeId = opts.newEdgeId ?? newEdgeId;
  let doc = base;
  const ops: CanvasOp[] = [];
  const touched: string[] = [];
  const aliases: Record<string, string> = {};
  const source: BoxSource = { ctx, ...(opts.images && { images: opts.images }) };
  /** Nodes whose place or box the edits changed: the frames around them may need to grow. */
  const shaped = new Set<string>();
  /** Positions given by hand, to move clear of other nodes once every edit is in. */
  const placed: string[] = [];

  for (const [index, edit] of edits.entries()) {
    const fail = (code: EditErrorCode, key: MessageKey, values?: MessageVars): never => {
      throw new EditError(index, code, t(key, values));
    };
    const resolve = (ref: string): string => {
      const id = aliases[ref] ?? ref;
      if (!doc.nodes[id]) fail("no_node", "canvas.edits.noNode", { id: ref });
      return id;
    };
    const labelOf = (spec: NodeSpec | undefined, type: string) => (spec ? t(spec.label) : type);
    const frameRef = (ref: string | null | undefined): string | null => {
      if (ref === null || ref === undefined) return null;
      const id = resolve(ref);
      if (doc.nodes[id]!.type !== "frame") fail("not_frame", "canvas.edits.notFrame", { id: ref });
      return id;
    };
    /** Canvas coordinates to coordinates inside `parentId`. */
    const within = (at: Point, parentId: string | null): Point => {
      if (parentId === null) return { x: Math.round(at.x), y: Math.round(at.y) };
      const origin = absolutePosition(doc, parentId);
      return { x: Math.round(at.x - origin.x), y: Math.round(at.y - origin.y) };
    };
    const emit = (next: CanvasOp[]) => {
      if (!next.length) return;
      try {
        doc = applyOps(doc, next).doc;
      } catch (error) {
        if (error instanceof CanvasOpError)
          fail("bad_edit", "canvas.edits.cantApply", { reason: error.message });
        throw error;
      }
      ops.push(...next);
    };
    const touch = (...ids: string[]) => {
      for (const id of ids) if (!touched.includes(id)) touched.push(id);
    };
    /** Checks a settings patch against the type and returns the merged params. */
    const mergeParams = (
      spec: NodeSpec,
      current: Readonly<Record<string, unknown>>,
      patch: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> => {
      const known = new Set([...Object.keys(spec.defaults(ctx)), ...Object.keys(spec.parseParams({}, ctx))]);
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (!known.has(key)) {
          fail("bad_param", "canvas.edits.noSetting", {
            node: t(spec.label),
            key,
            keys: [...known].join(", "),
          });
        }
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      const parsed = spec.parseParams(merged, ctx) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) continue;
        if (parsed[key] === undefined || canonicalJson(parsed[key]) !== canonicalJson(value)) {
          fail("bad_param", "canvas.edits.badSetting", {
            node: t(spec.label),
            key,
            value: JSON.stringify(value).slice(0, 120),
          });
        }
        const models = key === "model" ? [value] : key === "models" && Array.isArray(value) ? value : [];
        for (const model of models) {
          if (!ctx.model(String(model))) fail("bad_model", "canvas.edits.noModel", { model: String(model) });
        }
      }
      return merged;
    };

    switch (edit.op) {
      case "add_node": {
        const spec = specs.get(edit.type);
        if (!spec) fail("not_supported", "canvas.edits.notSupported", { type: edit.type });
        const def = spec!;
        if (edit.as !== undefined) {
          if (aliases[edit.as]) fail("bad_alias", "canvas.edits.aliasTaken", { alias: edit.as });
          if (doc.nodes[edit.as]) fail("bad_alias", "canvas.edits.aliasClash", { alias: edit.as });
        }
        const near =
          edit.near === undefined
            ? nearFor(edits, index, edit.as, aliases, doc)
            : { id: resolve(edit.near), side: "right" as const };
        // Beside a node that sits in a frame, the new one joins that frame unless told otherwise.
        const parentId =
          edit.parentId !== undefined
            ? frameRef(edit.parentId)
            : near
              ? (doc.nodes[near.id]?.parentId ?? null)
              : null;
        const node = specs.instantiate(def.type, { position: { x: 0, y: 0 }, ctx, parentId });
        node.id = nextNodeId();
        if (!localIdSchema.safeParse(node.id).success) throw new Error(`Bad node id ${node.id}`);
        if (edit.params) node.params = mergeParams(def, node.params, edit.params);
        // An image card is saved at the box it will show: its aspect ratio's, given here.
        if (def.imageBox)
          node.size = def.imageBox({ frame: node, params: node.params, result: null, ctx }, {});
        if (edit.size) {
          if (!def.resizable) fail("bad_edit", "canvas.edits.notResizable", { node: t(def.label) });
          node.size = clampSize(edit.size, def);
        }
        if (edit.title !== undefined) node.title = edit.title?.trim() || null;
        const size = node.size ?? def.size ?? { w: 160, h: 40 };
        const at =
          edit.position ??
          placeNode(doc, specs, {
            size,
            near: near?.id ?? null,
            side: near?.side ?? "right",
            parentId,
            source,
            ...(opts.viewport && { viewport: opts.viewport }),
          });
        node.position = within(at, parentId);
        emit([{ op: "addNode", node }]);
        if (edit.as !== undefined) aliases[edit.as] = node.id;
        touch(node.id);
        shaped.add(node.id);
        if (edit.position && !edit.exact) placed.push(node.id);
        break;
      }

      case "update_node": {
        const id = resolve(edit.id);
        const frame = doc.nodes[id]!;
        const spec = specs.get(frame.type);
        const next: CanvasOp[] = [];
        if (edit.params && Object.keys(edit.params).length) {
          if (!spec) fail("not_supported", "canvas.edits.notSupported", { type: frame.type });
          const merged = mergeParams(spec!, doc.params[id] ?? {}, edit.params);
          const patch: Record<string, unknown> = {};
          for (const key of Object.keys(edit.params)) patch[key] = merged[key];
          next.push({ op: "setParams", id, patch });
        }
        if (edit.title !== undefined) next.push({ op: "setTitle", id, title: edit.title?.trim() || null });
        if (edit.collapsed !== undefined) {
          if (spec?.annotation) fail("bad_edit", "canvas.edits.cantCollapse");
          next.push({ op: "setCollapsed", id, collapsed: edit.collapsed });
        }
        if (edit.size) {
          if (!spec?.resizable)
            fail("bad_edit", "canvas.edits.notResizable", { node: labelOf(spec, frame.type) });
          next.push({ op: "resizeNode", id, size: clampSize(edit.size, spec!) });
        }
        emit(next);
        touch(id);
        if (edit.params || edit.size) shaped.add(id);
        break;
      }

      case "move_node": {
        const id = resolve(edit.id);
        const frame = doc.nodes[id]!;
        const at = edit.position ?? absolutePosition(doc, id);
        if (edit.parentId !== undefined) {
          const parentId = frameRef(edit.parentId);
          if (parentId !== null && (parentId === id || containedIn(doc, id).includes(parentId)))
            fail("bad_edit", "canvas.edits.insideItself");
          emit([{ op: "reparent", id, parentId, position: within(at, parentId) }]);
        } else {
          emit([{ op: "moveNode", id, position: within(at, frame.parentId) }]);
        }
        touch(id);
        shaped.add(id);
        if (edit.position && !edit.exact && !placed.includes(id)) placed.push(id);
        break;
      }

      case "remove_nodes": {
        const doomed = new Set(edit.ids.map(resolve));
        const next: CanvasOp[] = [];
        // A frame's own nodes stay, handed to the frame around it, where they are on screen.
        for (const id of doomed) {
          if (doc.nodes[id]!.type !== "frame") continue;
          for (const child of doc.order.filter((c) => doc.nodes[c]?.parentId === id && !doomed.has(c))) {
            const parentId = nearestSurvivor(doc, id, doomed);
            next.push({
              op: "reparent",
              id: child,
              parentId,
              position: within(absolutePosition(doc, child), parentId),
            });
            shaped.add(child);
          }
        }
        // Deepest first, so every frame is empty by the time it goes.
        const depth = (id: string) => {
          let d = 0;
          for (let at = doc.nodes[id]?.parentId ?? null; at !== null; at = doc.nodes[at]?.parentId ?? null)
            d++;
          return d;
        };
        for (const id of [...doomed].sort((a, b) => depth(b) - depth(a))) next.push({ op: "deleteNode", id });
        emit(next);
        for (const id of doomed) {
          const at = touched.indexOf(id);
          if (at >= 0) touched.splice(at, 1);
        }
        break;
      }

      case "connect": {
        const source = resolve(edit.source);
        const target = resolve(edit.target);
        const from = specs.get(doc.nodes[source]!.type);
        const into = specs.get(doc.nodes[target]!.type);
        const arrow =
          edit.kind === "annotation" ||
          isAnnotationHandle(edit.sourceHandle) ||
          isAnnotationHandle(edit.targetHandle);
        let ends: ConnectionEnds;
        if (arrow) {
          ends = {
            source,
            sourceHandle: edit.sourceHandle ?? DEFAULT_ARROW.source,
            target,
            targetHandle: edit.targetHandle ?? DEFAULT_ARROW.target,
          };
          if (!isAnnotationHandle(ends.sourceHandle) || !isAnnotationHandle(ends.targetHandle))
            fail("cant_connect", "canvas.edits.badArrow");
        } else {
          const outs = pick(specs.ports(doc.nodes[source]!.type, "out"), edit.sourceHandle);
          const ins = pick(specs.ports(doc.nodes[target]!.type, "in"), edit.targetHandle);
          const fromLabel = labelOf(from, doc.nodes[source]!.type);
          const toLabel = labelOf(into, doc.nodes[target]!.type);
          if (!outs.ports.length) {
            if (edit.sourceHandle)
              fail("cant_connect", "canvas.edits.noOutput", {
                node: fromLabel,
                port: edit.sourceHandle,
                ports: outs.all,
              });
            fail("cant_connect", "canvas.edits.noOutputs", { node: fromLabel });
          }
          if (!ins.ports.length) {
            if (edit.targetHandle)
              fail("cant_connect", "canvas.edits.noInput", {
                node: toLabel,
                port: edit.targetHandle,
                ports: ins.all,
              });
            fail("cant_connect", "canvas.edits.noInputs", { node: toLabel });
          }
          const pair = bestPair(outs.ports, ins.ports);
          if (!pair) fail("cant_connect", "canvas.edits.noFit", { from: fromLabel, to: toLabel });
          ends = { source, sourceHandle: pair!.out.id, target, targetHandle: pair!.into.id };
        }
        // Asking again for a connection that's there changes nothing.
        const same = Object.values(doc.edges).some(
          (e) =>
            e.source === ends.source &&
            e.sourceHandle === ends.sourceHandle &&
            e.target === ends.target &&
            e.targetHandle === ends.targetHandle,
        );
        if (same) break;
        const check = checkConnection(doc, ends, specs);
        if (!check.ok) {
          if (check.reason) throw new EditError(index, "cant_connect", check.reason);
          fail("cant_connect", "canvas.edits.cantConnect");
        }
        const ok = check as Extract<typeof check, { ok: true }>;
        const next: CanvasOp[] = [];
        if (ok.replaces) next.push({ op: "deleteEdge", id: ok.replaces });
        let order: number | undefined;
        if (ok.kind === "data") {
          const port = specs.port(doc.nodes[target]!.type, ends.targetHandle!, "in");
          if (port?.arity === "multi") {
            const existing = incomingEdges(doc, target, ends.targetHandle!);
            order = existing.reduce((max, e, i) => Math.max(max, (e.order ?? i) + 1), 0);
          }
        }
        const edge: CanvasEdge = {
          id: nextEdgeId(),
          source,
          sourceHandle: ends.sourceHandle!,
          target,
          targetHandle: ends.targetHandle!,
          kind: ok.kind,
          ...(order !== undefined && { order }),
        };
        next.push({ op: "addEdge", edge });
        emit(next);
        touch(source, target);
        break;
      }

      case "disconnect": {
        let ids: string[];
        if (edit.edgeId !== undefined) {
          if (!doc.edges[edit.edgeId]) fail("no_edge", "canvas.edits.noEdge");
          ids = [edit.edgeId];
        } else {
          if (edit.source === undefined && edit.target === undefined)
            fail("bad_edit", "canvas.edits.whichEdge");
          const source = edit.source === undefined ? undefined : resolve(edit.source);
          const target = edit.target === undefined ? undefined : resolve(edit.target);
          ids = doc.edgeOrder.filter((id) => {
            const e = doc.edges[id]!;
            return (
              (source === undefined || e.source === source) &&
              (target === undefined || e.target === target) &&
              (edit.sourceHandle === undefined || e.sourceHandle === edit.sourceHandle) &&
              (edit.targetHandle === undefined || e.targetHandle === edit.targetHandle)
            );
          });
          if (!ids.length) fail("no_edge", "canvas.edits.noEdge");
        }
        const ends = ids.flatMap((id) => [doc.edges[id]!.source, doc.edges[id]!.target]);
        emit(ids.map((id): CanvasOp => ({ op: "deleteEdge", id })));
        touch(...ends);
        break;
      }

      case "rename_canvas":
        emit([{ op: "setName", name: edit.name.trim() }]);
        break;
    }
  }

  const notes: string[] = [];
  // Positions given by hand that landed on another node: the nearest free spot, in the order given.
  for (const id of placed) {
    if (!doc.nodes[id]) continue;
    const nudge = nudgeClear(doc, specs, id, source);
    if (!nudge) continue;
    const parentId = doc.nodes[id]!.parentId;
    const origin = parentId === null ? { x: 0, y: 0 } : absolutePosition(doc, parentId);
    const op: CanvasOp = {
      op: "moveNode",
      id,
      position: { x: nudge.to.x - origin.x, y: nudge.to.y - origin.y },
    };
    doc = applyOps(doc, [op]).doc;
    ops.push(op);
    notes.push(nudge.note);
  }

  // Every frame around a node that moved, changed shape or arrived grows to hold what's in it.
  const reached = new Set<string>();
  for (const id of shaped) {
    if (!doc.nodes[id]) continue;
    if (doc.nodes[id]!.type === "frame") reached.add(id);
    for (const frameId of framesAround(doc, doc.nodes[id]!.parentId)) reached.add(frameId);
  }
  const fitted = fitFrames(doc, specs, reached, source);
  doc = fitted.doc;
  ops.push(...fitted.ops);
  for (const id of fitted.grown) if (!touched.includes(id)) touched.push(id);

  return { ops, doc, touched: touched.filter((id) => doc.nodes[id]), aliases, notes };
}

/**
 * A node on top of another, moved to the nearest spot clear of everything but itself, what's in
 * it and the frames it's in. Null when it's clear where it is.
 */
function nudgeClear(
  doc: DocSlice,
  specs: NodeRegistry,
  id: string,
  source: BoxSource,
): { to: Point; note: string } | null {
  const rect = nodeRect(doc, specs, id, source);
  if (!rect) return null;
  const own = new Set([id, ...containedIn(doc, id), ...framesAround(doc, doc.nodes[id]!.parentId)]);
  const others = doc.order
    .filter((other) => !own.has(other))
    .flatMap((other) => {
      const box = nodeRect(doc, specs, other, source);
      return box ? [{ id: other, box }] : [];
    });
  const hits = others.filter((o) => overlaps(rect, o.box, 0));
  if (!hits.length) return null;
  const to = nearestFree(
    { x: rect.x, y: rect.y },
    { w: rect.w, h: rect.h },
    others.map((o) => o.box),
  );
  if (to.x === rect.x && to.y === rect.y) return null;
  // Named by how much they overlapped, most first.
  const area = (b: Rect) =>
    Math.max(0, Math.min(rect.x + rect.w, b.x + b.w) - Math.max(rect.x, b.x)) *
    Math.max(0, Math.min(rect.y + rect.h, b.y + b.h) - Math.max(rect.y, b.y));
  hits.sort((a, b) => area(b.box) - area(a.box));
  const title = (nodeId: string) => nodeTitle(doc.nodes[nodeId]!, specs);
  const dx = Math.round(to.x - rect.x);
  const dy = Math.round(to.y - rect.y);
  const along = (px: number, key: "right" | "left" | "down" | "up") =>
    t(`canvas.edits.nudge.${key}`, { px: Math.abs(px) });
  const x = dx ? along(dx, dx > 0 ? "right" : "left") : null;
  const y = dy ? along(dy, dy > 0 ? "down" : "up") : null;
  const shift = x && y ? t("canvas.edits.nudge.both", { x, y }) : (x ?? y)!;
  return {
    to,
    note: t("canvas.edits.nudged", {
      node: title(id),
      shift,
      others: listNames(hits.map((h) => title(h.id))),
    }),
  };
}

/** Two names are said, more are counted. */
export function listNames(list: readonly string[]): string {
  if (list.length > 2) return t("canvas.edits.names.many", { count: list.length });
  return list.length === 2 ? t("canvas.edits.names.pair", { a: list[0]!, b: list[1]! }) : (list[0] ?? "");
}

/** Ports to choose from, narrowed to the one asked for; `all` lists them for the error. */
function pick(ports: readonly PortSpec[], wanted: string | undefined) {
  const all = [...new Set(ports.map((p) => p.id))].join(", ");
  return { ports: wanted === undefined ? ports : ports.filter((p) => p.id === wanted), all };
}

/** The first output and input that fit, in rail order, a plain fit before a coerced one. */
function bestPair(outs: readonly PortSpec[], ins: readonly PortSpec[]) {
  let coerced: { out: PortSpec; into: PortSpec } | null = null;
  for (const into of ins) {
    for (const out of outs) {
      const flow = portFlow(out.type, into.type);
      if (flow === "ok") return { out, into };
      if (flow === "coerce" && !coerced) coerced = { out, into };
    }
  }
  return coerced;
}

/**
 * Where a new node without a position goes: beside what it connects to later in the same batch.
 * An input comes from its left, so a node that feeds another goes to that node's left.
 */
function nearFor(
  edits: readonly CanvasEdit[],
  index: number,
  alias: string | undefined,
  aliases: Readonly<Record<string, string>>,
  doc: DocSlice,
): { id: string; side: "right" | "left" } | null {
  if (alias === undefined) return null;
  const known = (ref: string) => {
    const id = aliases[ref] ?? ref;
    return ref !== alias && doc.nodes[id] ? id : null;
  };
  for (const edit of edits.slice(index + 1)) {
    if (edit.op !== "connect") continue;
    if (edit.target === alias && known(edit.source)) return { id: known(edit.source)!, side: "right" };
    if (edit.source === alias && known(edit.target)) return { id: known(edit.target)!, side: "left" };
  }
  return null;
}

/** The nearest frame around `id` that isn't being deleted too. */
function nearestSurvivor(doc: DocSlice, id: string, doomed: ReadonlySet<string>): string | null {
  let at = doc.nodes[id]?.parentId ?? null;
  while (at !== null && doomed.has(at)) at = doc.nodes[at]?.parentId ?? null;
  return at;
}

function clampSize(size: { w: number; h: number }, spec: NodeSpec) {
  const min = spec.minSize ?? { w: 40, h: 40 };
  return { w: Math.round(Math.max(min.w, size.w)), h: Math.round(Math.max(min.h, size.h)) };
}
