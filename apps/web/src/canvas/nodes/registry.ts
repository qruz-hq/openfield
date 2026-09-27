import {
  createNodeRegistry,
  type NodeSpec,
  type NodeRegistry as SpecRegistry,
} from "@openfield/canvas/nodes/registry";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { ANNOTATION_NODES } from "../editor/annotations/catalogue";
import type { LodBucket } from "../store/types";
import { DATA_NODES } from "./catalogue";

// The editor's node registry: each type's spec (@openfield/canvas, which the engine and the server
// share) plus what only the browser draws, its icon and components. Data nodes are defined in
// ./catalogue.ts (nodes agent), annotation nodes in ../editor/annotations/catalogue.ts (editor agent).

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

export interface NodeDefinition<P extends object = Record<string, unknown>> extends NodeSpec<P> {
  /** The add-node menu's and the node label's icon. */
  icon: LucideIcon;
  Component: ComponentType<NodeComponentProps>;
  /** The right drawer's node settings (design AWQzm), for nodes that have more than fits on them. */
  Inspector?: ComponentType<{ nodeId: string }>;
}

/** Erases a definition's params type so definitions of every type fit one list. */
export function defineNode<P extends object>(definition: NodeDefinition<P>): NodeDefinition {
  return definition as unknown as NodeDefinition;
}

export type NodeRegistry = SpecRegistry<NodeDefinition>;

/** Every node type this build knows. */
export const nodeRegistry: NodeRegistry = createNodeRegistry([...DATA_NODES, ...ANNOTATION_NODES]);
