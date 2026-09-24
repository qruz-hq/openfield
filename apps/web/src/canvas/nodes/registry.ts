import type { CanvasNodeType, MessageKey } from "@openfield/core";
import type { CanvasNode } from "@openfield/core/canvas";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { ANNOTATION_NODES } from "../editor/annotations/catalogue";
import { type EngineContext, type NodeEngine, PORT_SPACING, type PortSpec, portFlow } from "../engine/types";
import { newNodeId } from "../store/graph";
import type { Point, Size } from "../store/ops";
import type { LodBucket, PendingConnection } from "../store/types";
import { DATA_NODES } from "./catalogue";

// The node type registry. One definition per type says everything about it: how it looks in the
// add-node menu, its ports, its params and defaults, its engine half and its component. Data nodes
// are defined in ./catalogue.ts (nodes agent), annotation nodes in ../editor/annotations/catalogue.ts
// (editor agent). A type without a definition (Edit, Style, Upscale and the v1.1 nodes in this
// build) still loads and saves: the editor draws a labelled placeholder and keeps its data.

export type NodeCategory = "reference" | "generate" | "edit" | "utility" | "annotation";

/** Add-node menu groups, in menu order (§7.4, design CnYWZ). */
export const MENU_GROUPS = ["references", "image", "utilities"] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

/** What React Flow's node renderer hands every node component. Everything else comes from the store. */
export interface NodeComponentProps {
  id: string;
  selected: boolean;
  dragging: boolean;
  /** Measured box, when React Flow knows it. */
  width?: number;
  height?: number;
  lod: LodBucket;
}

export interface NodeDefinition<P extends object = Record<string, unknown>> {
  type: CanvasNodeType;
  /** Bump when params or ports change shape; it's part of the fingerprint. */
  typeVersion: number;
  /** The default label above the node, and the add-node menu name. */
  label: MessageKey;
  /** The add-node menu line under the name. */
  description: MessageKey;
  /** Extra words the add-node search matches, lower case, English. */
  keywords?: readonly string[];
  icon: LucideIcon;
  category: NodeCategory;
  /** null: never in the add-node menu (Text and Shape come from the toolbar). */
  menu: { group: MenuGroup; order: number } | null;
  /** Shown in the menu only when this says so, e.g. once some model can upscale. Default: always. */
  listed?: (ctx: EngineContext) => boolean;
  /** Default box. null: sized by its content (Text). */
  size: Size | null;
  minSize?: Size;
  resizable: boolean;
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
  Component: ComponentType<NodeComponentProps>;
  /** The right drawer's node settings (design AWQzm), for nodes that have more than fits on them. */
  Inspector?: ComponentType<{ nodeId: string }>;
}

/** Erases a definition's params type so definitions of every type fit one list. */
export function defineNode<P extends object>(definition: NodeDefinition<P>): NodeDefinition {
  return definition as unknown as NodeDefinition;
}

export interface NodeRegistry {
  get(type: string): NodeDefinition | undefined;
  all(): readonly NodeDefinition[];
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
    pending?: PendingConnection | null,
  ): { group: MenuGroup | "connects" | "other"; items: NodeDefinition[] }[];
  /** The port on `type` that a pending connection would attach to, first fit in rail order. */
  fittingPort(type: string, pending: PendingConnection): PortSpec | undefined;
  /** A new node with the type's defaults, ready for an addNode op. */
  instantiate(
    type: string,
    at: { position: Point; ctx: EngineContext; parentId?: string | null },
  ): CanvasNode;
}

export function createNodeRegistry(definitions: readonly NodeDefinition[]): NodeRegistry {
  const byType = new Map<string, NodeDefinition>();
  for (const def of definitions) {
    if (byType.has(def.type)) throw new Error(`Node type ${def.type} is defined twice`);
    byType.set(def.type, def);
  }

  const visible = (type: string) => byType.get(type)?.ports.filter((p) => !p.hidden) ?? [];

  const fittingPort = (type: string, pending: PendingConnection): PortSpec | undefined =>
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
      return {
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

/** Every node type this build knows. */
export const nodeRegistry: NodeRegistry = createNodeRegistry([...DATA_NODES, ...ANNOTATION_NODES]);
