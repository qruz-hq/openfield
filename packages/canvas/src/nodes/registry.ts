import type { CanvasNodeType, MessageKey } from "@openfield/core";
import type { CanvasNode, CanvasNodeResult } from "@openfield/core/canvas";
import {
  type EngineContext,
  type NodeEngine,
  PORT_SPACING,
  type PortSpec,
  type PortType,
  portFlow,
} from "../engine/types";
import { newNodeId } from "../store/graph";
import type { NodeFrame, Point, Size } from "../store/ops";

// The node type registry, without React: one spec per type says everything the engine and the
// server need, its ports, its params and defaults, its engine half and where it sits in the add-node
// menu. The web app adds each type's icon and components on top (apps/web nodes/registry.ts). A
// type without a spec (Edit, Style, Upscale and the v1.1 nodes in this build) still loads and
// saves: the editor draws a labelled placeholder and keeps its data.

export type NodeCategory = "reference" | "generate" | "edit" | "utility" | "annotation";

/** Add-node menu groups, in menu order (§7.4, design CnYWZ). */
export const MENU_GROUPS = ["references", "image", "utilities"] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

/** What a node's box can follow: its saved frame, its params and what it made. */
export interface NodeBoxInput {
  frame: NodeFrame;
  params: Readonly<Record<string, unknown>>;
  result: CanvasNodeResult | null;
  ctx: EngineContext;
}

/** Library images' pixel sizes by asset id, as far as they're known. */
export type ImageSizes = Readonly<Record<string, { w: number; h: number }>>;

/** A connection being dragged, as far as picking a port for it goes. */
export interface PortMatch {
  handleType: "source" | "target";
  portType: PortType;
}

export interface NodeSpec<P extends object = Record<string, unknown>> {
  type: CanvasNodeType;
  /** Bump when params or ports change shape; it's part of the fingerprint. */
  typeVersion: number;
  /** The default label above the node, and the add-node menu name. */
  label: MessageKey;
  /** The add-node menu line under the name. */
  description: MessageKey;
  /** Extra words the add-node search matches, lower case, English. */
  keywords?: readonly string[];
  category: NodeCategory;
  /** null: never in the add-node menu (Text and Shape come from the toolbar). */
  menu: { group: MenuGroup; order: number } | null;
  /** Shown in the menu only when this says so, e.g. once some model can upscale. Default: always. */
  listed?: (ctx: EngineContext) => boolean;
  /** Default box. null: sized by its content (Text). */
  size: Size | null;
  minSize?: Size;
  resizable: boolean;
  /**
   * A box that follows what the node shows instead of a hand-set size (Generate's image card).
   * It wins over the saved size, which follows `rest` so a saved canvas opens at the same box.
   */
  box?(input: NodeBoxInput): Size;
  /** With `box`: what the saved size follows, written by the editor when it changes (engine/boxes.ts). */
  rest?: {
    /** Changes when what the box rests on changes: a new image, a new aspect ratio or model. */
    key(input: Pick<NodeBoxInput, "params" | "result">): string;
    /** The box to save for it, or null while that box isn't exactly known yet. */
    box(input: NodeBoxInput): Size | null;
  };
  /**
   * An image card's box (Generate, Variations) worked out from the document and the library's image
   * sizes alone, where no browser measures it: the box agents place nodes by and fit frames around
   * (edits/place.ts), with or without a tab open. The same box the editor gives it at rest.
   */
  imageBox?(input: NodeBoxInput, images: ImageSizes): Size;
  /** Annotation nodes (Note, Frame, Text, Shape) stay out of the run graph and have no data ports. */
  annotation: boolean;
  /** Every port the type can have, in rail order (inputs top to bottom, then outputs). */
  ports: readonly PortSpec[];
  defaults(ctx: EngineContext): P;
  /** Reads saved params leniently: fills defaults, drops what it can't use, never throws. */
  parseParams(raw: Readonly<Record<string, unknown>>, ctx: EngineContext): P;
  runnable: boolean;
  /** Data nodes only. */
  engine?: NodeEngine<P>;
}

/** Erases a spec's params type so specs of every type fit one list. */
export function defineSpec<P extends object>(spec: NodeSpec<P>): NodeSpec {
  return spec as unknown as NodeSpec;
}

/** Specs by type. The web app's registry holds its fuller definitions, and fits wherever this does. */
export interface NodeRegistry<D extends NodeSpec = NodeSpec> {
  get(type: string): D | undefined;
  all(): readonly D[];
  /** Visible ports of a type, optionally one direction. */
  ports(type: string, direction?: PortSpec["direction"]): readonly PortSpec[];
  /** A port by id. Prompt uses "text" for both its input and its output, so pass the direction. */
  port(type: string, portId: string, direction?: PortSpec["direction"]): PortSpec | undefined;
  /**
   * Add-node menu rows by group, in order, listed types only. With a pending connection it returns
   * the drop-on-empty menu instead: "connects" (types with a port that fits) and "other".
   */
  menu(
    ctx: EngineContext,
    pending?: PortMatch | null,
  ): { group: MenuGroup | "connects" | "other"; items: D[] }[];
  /** The port on `type` that a pending connection would attach to, first fit in rail order. */
  fittingPort(type: string, pending: PortMatch): PortSpec | undefined;
  /** A new node with the type's defaults, ready for an addNode op. */
  instantiate(
    type: string,
    at: { position: Point; ctx: EngineContext; parentId?: string | null },
  ): CanvasNode;
}

export function createNodeRegistry<D extends NodeSpec>(definitions: readonly D[]): NodeRegistry<D> {
  const byType = new Map<string, D>();
  for (const def of definitions) {
    if (byType.has(def.type)) throw new Error(`Node type ${def.type} is defined twice`);
    byType.set(def.type, def);
  }

  const visible = (type: string) => byType.get(type)?.ports.filter((p) => !p.hidden) ?? [];

  const fittingPort = (type: string, pending: PortMatch): PortSpec | undefined =>
    visible(type).find((port) =>
      // Dragging from an output looks for an input it can flow into, and the other way round.
      pending.handleType === "source"
        ? port.direction === "in" && portFlow(pending.portType, port.type) !== "no"
        : port.direction === "out" && portFlow(port.type, pending.portType) !== "no",
    );

  const listed = (ctx: EngineContext) =>
    [...byType.values()]
      .filter((d) => d.menu !== null && (d.listed?.(ctx) ?? true))
      .sort(
        (a, b) =>
          MENU_GROUPS.indexOf(a.menu!.group) - MENU_GROUPS.indexOf(b.menu!.group) ||
          a.menu!.order - b.menu!.order,
      );

  return {
    get: (type) => byType.get(type),
    all: () => [...byType.values()],
    ports: (type, direction) => visible(type).filter((p) => !direction || p.direction === direction),
    port: (type, portId, direction) =>
      byType.get(type)?.ports.find((p) => p.id === portId && (!direction || p.direction === direction)),
    fittingPort,

    menu(ctx, pending) {
      const items = listed(ctx);
      if (pending) {
        const connects = items.filter((d) => fittingPort(d.type, pending));
        const other = items.filter((d) => !connects.includes(d));
        // Both keep catalogue order: group, then order.
        return [
          { group: "connects" as const, items: connects },
          { group: "other" as const, items: other },
        ].filter((g) => g.items.length);
      }
      return MENU_GROUPS.map((group) => ({
        group,
        items: items.filter((d) => d.menu!.group === group),
      })).filter((g) => g.items.length);
    },

    instantiate(type, { position, ctx, parentId = null }) {
      const def = byType.get(type);
      if (!def) throw new Error(`No node type ${type}`);
      const node: CanvasNode = {
        id: newNodeId(),
        type: def.type,
        typeVersion: def.typeVersion,
        position: { ...position },
        ...(def.size && { size: { ...def.size } }),
        parentId,
        collapsed: false,
        title: null,
        params: { ...def.defaults(ctx) },
        presetLocks: [],
        result: null,
      };
      // A box that follows what the node shows starts at the shape its defaults ask for, so the
      // node is placed (and saved) at the size it draws.
      if (def.box) node.size = { ...def.box({ frame: node, params: node.params, result: null, ctx }) };
      return node;
    },
  };
}

/**
 * Centres of a rail's ports, from the node's top: 36 apart around the vertical middle, counting
 * visible ports only (Canvas kit pUPWt). Ports are centred on the node edge.
 */
export function railOffsets(count: number, height: number): number[] {
  const middle = height / 2;
  const first = middle - ((count - 1) * PORT_SPACING) / 2;
  return Array.from({ length: count }, (_, i) => first + i * PORT_SPACING);
}
