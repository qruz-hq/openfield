import { absolutePosition } from "@openfield/canvas/store/graph";
import { getBezierPath, Position, type ReactFlowState, useStore } from "@xyflow/react";
import { useId } from "react";
import { nodeRegistry } from "../../nodes/registry";
import { useCanvas } from "../../store";

// While a link is dragged from a node in a multi-selection, every other selected node draws its own
// pending line to the cursor too, since the drop connects them all (planGroupConnect). The lines grow
// out of their ports one after another, in canvas order (editor.css, of-pending-draw); React Flow
// redraws them with the dragged line as the cursor moves, so nothing runs per frame here.

/** How far apart the lines start growing, in canvas order. */
const STAGGER_MS = 50;

interface Source {
  id: string;
  x: number;
  y: number;
  position: Position;
}

/**
 * The other selected nodes' ports on the dragged port's side, top to bottom then left to right, as
 * "node:port" pairs. The dragged port's own id first, then one of the same type, then the first.
 */
function useGroupPorts(fromNodeId: string, fromHandleId: string, side: "source" | "target"): string {
  return useCanvas((s) => {
    const selection = s.selection.nodeIds;
    if (selection.length < 2 || !selection.includes(fromNodeId)) return "";
    const type = s.ui.connecting?.portType;
    return selection
      .filter((id) => id !== fromNodeId && s.doc.nodes[id])
      .map((id) => ({ id, at: absolutePosition(s.doc, id) }))
      .sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)
      .flatMap(({ id }) => {
        const ports = nodeRegistry.ports(s.doc.nodes[id]!.type, side === "source" ? "out" : "in");
        const port =
          ports.find((p) => p.id === fromHandleId) ?? ports.find((p) => p.type === type) ?? ports[0];
        return port ? [`${id}:${port.id}`] : [];
      })
      .join("|");
  });
}

/** Where each of those ports sits on the pane: its outer edge, clear of the port's circle. */
function useSources(pairs: string, side: "source" | "target"): Source[] {
  const key = useStore((s: ReactFlowState) => {
    if (!pairs) return "";
    return pairs
      .split("|")
      .flatMap((pair) => {
        const [nodeId = "", portId] = pair.split(":");
        const node = s.nodeLookup.get(nodeId);
        const handle = node?.internals.handleBounds?.[side]?.find((h) => h.id === portId);
        if (!node || !handle) return [];
        const { x, y } = node.internals.positionAbsolute;
        const edge = handle.position === Position.Right ? x + handle.x + handle.width : x + handle.x;
        return [`${nodeId},${edge},${y + handle.y + handle.height / 2},${handle.position}`];
      })
      .join("|");
  });
  if (!key) return [];
  return key.split("|").map((row) => {
    const [id = "", x = "0", y = "0", position] = row.split(",");
    return { id, x: Number(x), y: Number(y), position: position as Position };
  });
}

interface GroupLinesProps {
  fromNodeId: string;
  fromHandleId: string;
  side: "source" | "target";
  toX: number;
  toY: number;
  toPosition: Position;
}

export function GroupLines({ fromNodeId, fromHandleId, side, toX, toY, toPosition }: GroupLinesProps) {
  const sources = useSources(useGroupPorts(fromNodeId, fromHandleId, side), side);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  return (
    <>
      {sources.map((source, i) => {
        const [path] = getBezierPath({
          sourceX: source.x,
          sourceY: source.y,
          sourcePosition: source.position,
          targetX: toX,
          targetY: toY,
          targetPosition: toPosition,
        });
        const mask = `of-group-line-${uid}-${i}`;
        return (
          <g key={source.id}>
            {/* A solid copy of the path, drawn from the port on: it reveals the dashed line as it grows. */}
            <mask id={mask} maskUnits="userSpaceOnUse" x={-1e6} y={-1e6} width={2e6} height={2e6}>
              <path
                d={path}
                pathLength={1}
                fill="none"
                stroke="#fff"
                strokeWidth={8}
                className="of-pending-draw"
                style={{ animationDelay: `${i * STAGGER_MS}ms` }}
              />
            </mask>
            <path d={path} fill="none" className="of-pending" mask={`url(#${mask})`} />
          </g>
        );
      })}
    </>
  );
}
