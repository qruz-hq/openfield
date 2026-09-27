import { getBezierPath, Position, type ReactFlowState, useStore, ViewportPortal } from "@xyflow/react";
import { shallow } from "zustand/shallow";
import { useUi } from "../../store";

// A connection dropped on empty pane stays drawn, dashed, from its port to the drop point while the
// add-node menu is open (design Ij3T5: XX79M with the XTMYH ring), and goes when the menu closes.

export function PendingEdge() {
  const menu = useUi((ui) => ui.addMenu);
  const pending = menu?.pending ?? null;
  const from = useStore((s: ReactFlowState) => {
    if (!pending) return null;
    const node = s.nodeLookup.get(pending.nodeId);
    const bounds = node?.internals.handleBounds?.[pending.handleType];
    const handle = bounds?.find((h) => h.id === pending.handleId);
    if (!node || !handle) return null;
    const { x, y } = node.internals.positionAbsolute;
    // From the port's outer edge: this is drawn above the nodes and must not cover the port's circle.
    return {
      x: x + handle.x + (handle.position === Position.Right ? handle.width : 0),
      y: y + handle.y + handle.height / 2,
      position: handle.position,
    };
  }, shallow);
  if (!menu || !pending || !from) return null;
  const to = menu.flowPosition;
  const toPosition = from.position === Position.Right ? Position.Left : Position.Right;
  const [path] = getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: from.position,
    targetX: to.x,
    targetY: to.y,
    targetPosition: toPosition,
  });
  return (
    <ViewportPortal>
      <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible">
        <path d={path} fill="none" className="of-pending" />
        <circle cx={to.x} cy={to.y} r={4} className="of-pending-ring" />
      </svg>
    </ViewportPortal>
  );
}
