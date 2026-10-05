import { CANVAS_NODE_TYPES } from "@openfield/core";
import { CANVAS_EDITS_MAX, type CanvasDocument, type CanvasEdit } from "@openfield/core/canvas";
import type { Host } from "./sandbox";

// What a script's calls do: reads answer from a snapshot of the canvas with the script's own pending
// edits laid over it, writes are only recorded. The caller validates and applies the plan.

export const MAX_PRINT_LINES = 60;
export const MAX_PRINT_CHARS = 4000;
export const MAX_ARG_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;

interface Shown {
  id: string;
  type: string;
  title: string | null;
  params: Record<string, unknown>;
  parentId: string | null;
  x?: number;
  y?: number;
}

export interface Plan {
  edits: CanvasEdit[];
  /** The script line each edit came from, for refusals. */
  lines: number[];
  prints: string[];
  remembered: Map<string, unknown>;
}

const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function newPlan(): Plan {
  return { edits: [], lines: [], prints: [], remembered: new Map() };
}

export function planHost(
  doc: Pick<CanvasDocument, "nodes" | "edges">,
  plan: Plan,
  stored: Map<string, unknown>,
): Host {
  const nodes = new Map<string, Shown>(
    doc.nodes.map((n) => [
      n.id,
      {
        id: n.id,
        type: n.type,
        title: n.title,
        params: { ...n.params },
        parentId: n.parentId,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      },
    ]),
  );
  let edges = doc.edges.map((e) => ({
    id: e.id,
    from: `${e.source}.${e.sourceHandle}`,
    to: `${e.target}.${e.targetHandle}`,
  }));
  let auto = 0;
  let printed = 0;
  let printChars = 0;

  const record = (edit: CanvasEdit, line: number) => {
    if (plan.edits.length >= CANVAS_EDITS_MAX) {
      throw new Error(`A script can make at most ${CANVAS_EDITS_MAX} edits.`);
    }
    plan.edits.push(edit);
    plan.lines.push(line);
  };
  const need = (id: unknown): Shown => {
    const node = typeof id === "string" ? nodes.get(id) : undefined;
    if (!node)
      throw new Error(`There's no node "${String(id)}" on the canvas or added earlier in the script.`);
    return node;
  };
  const point = (v: unknown): { x: number; y: number } | undefined =>
    isRecord(v) && typeof v.x === "number" && typeof v.y === "number" ? { x: v.x, y: v.y } : undefined;
  const merge = (into: Record<string, unknown>, params: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(params)) {
      if (v === null) delete into[k];
      else into[k] = v;
    }
  };
  const view = (n: Shown) => ({ ...n, params: { ...n.params } });
  const end = (v: unknown): string => {
    if (typeof v !== "string" || !v) throw new Error('A connection end is "nodeId.port" or "nodeId".');
    return v;
  };

  return (name, args, line) => {
    if (JSON.stringify(args).length > MAX_ARG_BYTES) throw new Error("That call's arguments are too large.");
    switch (name) {
      case "print": {
        for (const text of (args[0] as string[]) ?? []) {
          if (printed >= MAX_PRINT_LINES || printChars >= MAX_PRINT_CHARS) break;
          plan.prints.push(text.slice(0, MAX_PRINT_CHARS - printChars));
          printed++;
          printChars += text.length;
        }
        return undefined;
      }
      case "nodes": {
        const filter = isRecord(args[0]) ? args[0] : {};
        return [...nodes.values()]
          .filter((n) => (typeof filter.type === "string" ? n.type === filter.type : true))
          .filter((n) => (typeof filter.parentId === "string" ? n.parentId === filter.parentId : true))
          .map(view);
      }
      case "node":
        return nodes.has(String(args[0])) ? view(need(args[0])) : null;
      case "edges":
        return edges;
      case "nodeTypes":
        return [...CANVAS_NODE_TYPES];
      case "add": {
        const [type, params, opts] = args;
        if (!(CANVAS_NODE_TYPES as readonly string[]).includes(type as string)) {
          throw new Error(`"${String(type)}" isn't a node type. Types: ${CANVAS_NODE_TYPES.join(", ")}.`);
        }
        const o = isRecord(opts) ? opts : {};
        const id = typeof o.as === "string" ? o.as : `n${++auto}`;
        if (!ALIAS.test(id) || nodes.has(id)) {
          throw new Error(`"${id}" can't name a new node: use letters, digits, _ or -, not used already.`);
        }
        const at = point(o.at);
        const edit: CanvasEdit = {
          op: "add_node",
          as: id,
          type: type as (typeof CANVAS_NODE_TYPES)[number],
          ...(isRecord(params) && { params }),
          ...(o.title !== undefined && { title: o.title as string | null }),
          ...(at && { position: at }),
          ...(o.exact === true && { exact: true }),
          ...(typeof o.parent === "string" && { parentId: o.parent }),
          ...(typeof o.near === "string" && { near: o.near }),
        };
        record(edit, line);
        nodes.set(id, {
          id,
          type: type as string,
          title: (o.title as string | null | undefined) ?? null,
          params: isRecord(params) ? { ...params } : {},
          parentId: typeof o.parent === "string" ? o.parent : null,
          ...(at && at),
        });
        return id;
      }
      case "set": {
        const [id, params, opts] = args;
        const node = need(id);
        const o = isRecord(opts) ? opts : {};
        record(
          {
            op: "update_node",
            id: node.id,
            ...(isRecord(params) && { params }),
            ...(o.title !== undefined && { title: o.title as string | null }),
            ...(typeof o.collapsed === "boolean" && { collapsed: o.collapsed }),
          },
          line,
        );
        if (isRecord(params)) merge(node.params, params);
        if (o.title !== undefined) node.title = o.title as string | null;
        return undefined;
      }
      case "move": {
        const [id, to, opts] = args;
        const node = need(id);
        const o = isRecord(opts) ? opts : {};
        const at = point(to);
        record(
          {
            op: "move_node",
            id: node.id,
            ...(at && { position: at }),
            ...(o.exact === true && { exact: true }),
            ...(o.parent !== undefined && { parentId: o.parent as string | null }),
          },
          line,
        );
        if (at) Object.assign(node, at);
        if (o.parent !== undefined) node.parentId = o.parent as string | null;
        return undefined;
      }
      case "remove": {
        const ids = (args[0] as unknown[]).map((id) => need(id).id);
        if (!ids.length) return undefined;
        record({ op: "remove_nodes", ids }, line);
        for (const id of ids) nodes.delete(id);
        edges = edges.filter(
          (e) => !ids.some((id) => e.from.startsWith(`${id}.`) || e.to.startsWith(`${id}.`)),
        );
        return undefined;
      }
      case "connect": {
        const from = end(args[0]);
        const to = end(args[1]);
        const [sNode, sPort] = from.split(".") as [string, string | undefined];
        const [tNode, tPort] = to.split(".") as [string, string | undefined];
        need(sNode);
        need(tNode);
        record(
          {
            op: "connect",
            source: sNode,
            ...(sPort && { sourceHandle: sPort }),
            target: tNode,
            ...(tPort && { targetHandle: tPort }),
            ...(args[2] === "annotation" && { kind: "annotation" as const }),
          },
          line,
        );
        edges.push({ id: `pending-${edges.length}`, from, to });
        return undefined;
      }
      case "disconnect": {
        const [sNode, sPort] = end(args[0]).split(".") as [string, string | undefined];
        const [tNode, tPort] = end(args[1]).split(".") as [string, string | undefined];
        record(
          {
            op: "disconnect",
            source: sNode,
            target: tNode,
            ...(sPort && { sourceHandle: sPort }),
            ...(tPort && { targetHandle: tPort }),
          },
          line,
        );
        return undefined;
      }
      case "rename": {
        record({ op: "rename_canvas", name: String(args[0]) }, line);
        return undefined;
      }
      case "remember": {
        const [key, payload] = args;
        if (typeof key !== "string" || !key) throw new Error("Remember needs a name.");
        plan.remembered.set(key, payload);
        return undefined;
      }
      case "recall": {
        const key = String(args[0]);
        return plan.remembered.get(key) ?? stored.get(key);
      }
      default:
        throw new Error(`Unknown call ${name}.`);
    }
  };
}
