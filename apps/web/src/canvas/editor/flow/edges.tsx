import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import {
  type ConnectionLineComponentProps,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
  getBezierPath,
  getSimpleBezierPath,
  Position,
} from "@xyflow/react";
import { SquareDashed, X } from "lucide-react";
import { createContext, memo, useContext, useRef, useState } from "react";
import { isAnnotationHandle } from "../../engine/types";
import { useCanvasActions, useReadOnly } from "../../store";
import { ANNOTATION_EDGE_TYPE, DATA_EDGE_TYPE, type FlowEdge } from "./adapter";

// Edge recipes (design Z73S2). Data: a 1.5 px $border-strong bezier; hovered, 2.5 px $accent with a
// 16 px × at the midpoint; selected, 2.5 px $accent with 6 px dots at both ends. Annotation arrows:
// 4/4 dashes in $text-tertiary with a filled arrowhead, never data. Pending: 6/5 dashes in
// $accent-line with an 8 px $accent ring at the cursor.

const HIT_WIDTH = 20;

/** Past 300 edges the pane draws the cheaper curve (§7.10). */
export const EdgeModeContext = createContext(false);

function usePath(
  p: Pick<EdgeProps, "sourceX" | "sourceY" | "targetX" | "targetY" | "sourcePosition" | "targetPosition">,
) {
  const simple = useContext(EdgeModeContext);
  return simple ? getSimpleBezierPath(p) : getBezierPath(p);
}

const DataEdge = memo(function DataEdge(props: EdgeProps<FlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data } = props;
  const [path, labelX, labelY] = usePath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const actions = useCanvasActions();
  const readOnly = useReadOnly();
  const [hover, setHover] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const enter = () => {
    clearTimeout(leave.current);
    setHover(true);
  };
  // A short grace period so the pointer can travel from the line onto the × button.
  const exit = () => {
    clearTimeout(leave.current);
    leave.current = setTimeout(() => setHover(false), 120);
  };
  const active = hover || selected;

  return (
    <>
      <g onPointerEnter={enter} onPointerLeave={exit}>
        <path
          d={path}
          fill="none"
          className={cn("react-flow__edge-path of-edge", active && "of-edge-active")}
        />
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={HIT_WIDTH}
          className="react-flow__edge-interaction"
        />
        {selected ? (
          <>
            <circle cx={sourceX} cy={sourceY} r={3} className="fill-accent" />
            <circle cx={targetX} cy={targetY} r={3} className="fill-accent" />
          </>
        ) : null}
      </g>
      {(hover && !readOnly) || data?.coerce ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-4"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onPointerEnter={enter}
            onPointerLeave={exit}
          >
            {data?.coerce && !hover ? (
              <span className="flex size-16 items-center justify-center rounded-full bg-elevated-2 text-text-secondary inset-ring inset-ring-border-strong">
                <SquareDashed size={10} aria-hidden />
              </span>
            ) : null}
            {hover && !readOnly ? (
              <button
                type="button"
                aria-label={t("canvas.editor.selection.delete")}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.deleteEdges([id]);
                }}
                className="flex size-16 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-fg"
              >
                <X size={10} strokeWidth={2.5} aria-hidden />
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

/** Where an arrowhead points, from the side of the node it lands on. */
const ARROW_ROTATION: Record<Position, number> = {
  [Position.Left]: 0,
  [Position.Top]: 90,
  [Position.Right]: 180,
  [Position.Bottom]: 270,
};

function Arrowhead({ x, y, side }: { x: number; y: number; side: Position }) {
  // A 10 px filled triangle with its tip on the handle.
  return (
    <path
      d="M-10,-5 L0,0 L-10,5 Z"
      transform={`translate(${x},${y}) rotate(${ARROW_ROTATION[side]})`}
      className="fill-text-tertiary"
    />
  );
}

const AnnotationEdge = memo(function AnnotationEdge(props: EdgeProps<FlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const [path] = usePath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <g>
      <path
        d={path}
        fill="none"
        className={cn("react-flow__edge-path of-arrow", selected && "of-arrow-selected")}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_WIDTH}
        className="react-flow__edge-interaction"
      />
      <Arrowhead x={targetX} y={targetY} side={targetPosition} />
    </g>
  );
});

export const edgeTypes: EdgeTypes = {
  [DATA_EDGE_TYPE]: DataEdge,
  [ANNOTATION_EDGE_TYPE]: AnnotationEdge,
};

/** The edge while it's being dragged (design H0bfJn; XX79M and the XTMYH ring on Ij3T5). */
export function ConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  fromHandle,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const arrow = isAnnotationHandle(fromHandle?.id);
  return (
    <g>
      <path d={path} fill="none" className={arrow ? "of-arrow of-pending-arrow" : "of-pending"} />
      <circle cx={toX} cy={toY} r={4} className="of-pending-ring" />
    </g>
  );
}
