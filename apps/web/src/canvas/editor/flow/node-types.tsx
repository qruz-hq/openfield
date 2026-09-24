import type { NodeProps, NodeTypes } from "@xyflow/react";
import { type ComponentType, createContext, memo, useContext } from "react";
import type { NodeComponentProps, NodeRegistry } from "../../nodes/registry";
import { useUi } from "../../store";
import type { LodBucket } from "../../store/types";
import { UNKNOWN_NODE_TYPE } from "./adapter";
import { UnknownNode } from "./unknown-node";

// React Flow node types, one per registered definition. Each wrapper hands the component the props
// the registry promises (id, selected, dragging, size, level of detail) and nothing else: node data
// stays empty and components read the store by id.

/** The preview capture renders every node at full detail, whatever the zoom. */
export const ForcedLodContext = createContext<LodBucket | null>(null);

function useLod(): LodBucket {
  const forced = useContext(ForcedLodContext);
  const lod = useUi((ui) => ui.lod);
  return forced ?? lod;
}

function wrap(Component: ComponentType<NodeComponentProps>) {
  return memo(function CanvasNode({ id, selected, dragging, width, height }: NodeProps) {
    const lod = useLod();
    return (
      <Component
        id={id}
        selected={!!selected}
        dragging={!!dragging}
        width={width}
        height={height}
        lod={lod}
      />
    );
  });
}

export function buildNodeTypes(registry: NodeRegistry): NodeTypes {
  const types: NodeTypes = { [UNKNOWN_NODE_TYPE]: UnknownNode };
  for (const def of registry.all()) types[def.type] = wrap(def.Component);
  return types;
}
