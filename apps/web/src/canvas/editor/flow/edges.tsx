import { isAnnotationHandle } from "@openfield/canvas/engine/types";
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
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useCompanyWait } from "../../nodes/shell/company-wait";
import { useLinkLit } from "../../nodes/shell/linked-text";
import { useCanvas, useCanvasActions, useReadOnly } from "../../store";
import { ANNOTATION_EDGE_TYPE, DATA_EDGE_TYPE, type FlowEdge } from "./adapter";
import { freshLinkDelay } from "./fresh-links";
import { GroupLines } from "./group-lines";
import { useFadeOut, useReducedMotion } from "./motion-state";
import { type LinkActivity, linkActivity } from "./pulse";
import { type PulseHandle, startPulse } from "./pulse-clock";

// Links (design YQPWR, components USl4U…RHGMm; recipes Z73S2). Data: a 1.5 px $border-strong
// bezier from port centre to port centre; hovered, 2 px $text-tertiary with a 16 px × at the
// midpoint; selected, 2.5 px $accent with 6 px dots 13 px in from each end, and the × stays. While the node it
// feeds is generating, the line turns $accent-line and a light pulse runs from source to target
// on the canvas's shared clock (pulse-clock.ts); while that node waits at the company, the line
// stays lit without moving; with reduced motion, a static 2 px gradient from $accent-line at the
// source to $accent at the target. Annotation arrows: 4/4 dashes in $text-tertiary with a filled
// arrowhead, never data. Pending: 6/5 dashes in $accent-line with an 8 px $accent ring.

/** The invisible stroke that catches the pointer along a link. */
const HIT_WIDTH = 16;
/** Selected dots sit this far in from each end, clear of the ports. */
const DOT_INSET = 13;
/** How long a pulse takes to fade where it is when the run ends. */
const FADE_MS = 200;
/** A link a group drop just made draws in over this long (editor.css, of-link-draw). */
const DRAW_MS = 180;
/**
 * Ports are 24 px circles centred on the node's side. React Flow hands a link the port's outer
 * edge; links run from port centre to port centre (formula x4Vq3), so a pulse comes out from under
 * one port and sinks under the other.
 */
const PORT_RADIUS = 12;
const portCentre = (x: number, side: Position) =>
  side === Position.Right ? x - PORT_RADIUS : side === Position.Left ? x + PORT_RADIUS : x;

/** Past 300 edges the pane draws the cheaper curve (§7.10). */
export const EdgeModeContext = createContext(false);

function usePath(
  p: Pick<EdgeProps, "sourceX" | "sourceY" | "targetX" | "targetY" | "sourcePosition" | "targetPosition">,
) {
  const simple = useContext(EdgeModeContext);
  return simple ? getSimpleBezierPath(p) : getBezierPath(p);
}

/** What the node a link feeds is doing, as far as the link shows it (pulse.ts). */
function useLinkActivity(target: string): LinkActivity {
  const state = useCanvas((s) => s.runtime[target]?.state);
  const wait = useCompanyWait(target);
  return linkActivity(state ? { state } : undefined, wait !== null);
}

/** Ids used in url(#…) references: letters, digits, _ and - only. */
const svgId = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

const DataEdge = memo(function DataEdge(props: EdgeProps<FlowEdge>) {
  const { id, target, sourceY, targetY, sourcePosition, targetPosition, selected, data } = props;
  const sourceX = portCentre(props.sourceX, sourcePosition);
  const targetX = portCentre(props.targetX, targetPosition);
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
  const activity = useLinkActivity(target);
  // The words it carries are hovered on the card they go into (nodes/shell/linked-text.tsx).
  const lit = useLinkLit(id);
  // Made by a group drop a moment ago: it draws in from its source, then is an ordinary link.
  const [drawDelay, setDrawDelay] = useState(() => freshLinkDelay(id));
  useEffect(() => {
    if (drawDelay === null) return;
    const timer = setTimeout(() => setDrawDelay(null), drawDelay + DRAW_MS + 50);
    return () => clearTimeout(timer);
  }, [drawDelay]);
  const reduced = useReducedMotion();
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

  // Selected wins over everything: the pulse hides while the link is selected.
  const running = activity === "active" && !reduced;
  // The × shows on hover and stays while the link is selected, so it can be removed either way.
  const removable = (hover || selected) && !readOnly;
  const fading = useFadeOut(running, FADE_MS);
  const pulsing = running && !selected;
  const drawPulse = (pulsing || fading) && !selected;
  const still = activity === "active" && reduced && !selected;
  const look = still ? "reduced" : activity;

  const line = useRef<SVGPathElement>(null);
  const core = useRef<SVGPathElement>(null);
  const glow = useRef<SVGPathElement>(null);
  const gradient = useRef<SVGLinearGradientElement>(null);
  const handle = useRef<PulseHandle | null>(null);
  useLayoutEffect(() => {
    if (!pulsing || !line.current || !core.current || !gradient.current) return;
    const pulse = startPulse({
      line: line.current,
      core: core.current,
      glow: glow.current,
      gradient: gradient.current,
    });
    handle.current = pulse;
    return () => {
      pulse.stop();
      handle.current = null;
    };
  }, [pulsing]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new path is the reason to measure again.
  useLayoutEffect(() => handle.current?.remeasure(), [path]);

  // Unique per drawing: the card pictures (preview-capture.tsx) draw the same edges off screen.
  const uid = useId();
  const pulseId = svgId("of-pulse", `${id}-${uid}`);
  const stillId = svgId("of-link", `${id}-${uid}`);

  return (
    <>
      <g onPointerEnter={enter} onPointerLeave={exit}>
        {drawPulse ? (
          <defs>
            {/* Tail to head along the pulse: $accent-clear, then $accent from 80% to the head. */}
            <linearGradient ref={gradient} id={pulseId} gradientUnits="userSpaceOnUse">
              <stop offset="0" style={{ stopColor: "var(--of-accent-clear)" }} />
              <stop offset="0.8" style={{ stopColor: "var(--of-accent)" }} />
              <stop offset="1" style={{ stopColor: "var(--of-accent)" }} />
            </linearGradient>
          </defs>
        ) : null}
        {still ? (
          <defs>
            <linearGradient
              id={stillId}
              gradientUnits="userSpaceOnUse"
              x1={sourceX}
              y1={sourceY}
              x2={targetX}
              y2={targetY}
            >
              <stop offset="0" style={{ stopColor: "var(--of-accent-line)" }} />
              <stop offset="1" style={{ stopColor: "var(--of-accent)" }} />
            </linearGradient>
          </defs>
        ) : null}
        {drawPulse ? (
          <path
            ref={glow}
            d={path}
            fill="none"
            stroke={`url(#${pulseId})`}
            visibility="hidden"
            className={cn("of-pulse of-pulse-glow", fading && "of-pulse-out")}
          />
        ) : null}
        <path
          ref={line}
          d={path}
          fill="none"
          data-link={selected ? undefined : look}
          data-hover={(hover && !selected) || undefined}
          data-linked={(lit && !selected) || undefined}
          pathLength={drawDelay === null ? undefined : 1}
          style={{
            ...(still && { stroke: `url(#${stillId})` }),
            ...(drawDelay !== null && { animationDelay: `${drawDelay}ms` }),
          }}
          className={cn(
            "react-flow__edge-path of-edge",
            selected && "of-edge-selected",
            drawDelay !== null && "of-link-draw",
          )}
        />
        {drawPulse ? (
          <path
            ref={core}
            d={path}
            fill="none"
            stroke={`url(#${pulseId})`}
            visibility="hidden"
            className={cn("of-pulse of-pulse-core", fading && "of-pulse-out")}
          />
        ) : null}
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={HIT_WIDTH}
          className="react-flow__edge-interaction"
        />
        {selected ? (
          <>
            <circle cx={sourceX + DOT_INSET} cy={sourceY} r={3} className="fill-accent" />
            <circle cx={targetX - DOT_INSET} cy={targetY} r={3} className="fill-accent" />
          </>
        ) : null}
      </g>
      {removable || data?.coerce ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-4"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onPointerEnter={enter}
            onPointerLeave={exit}
          >
            {data?.coerce && !removable ? (
              <span className="flex size-16 items-center justify-center rounded-full bg-elevated-2 text-text-secondary inset-ring inset-ring-border-strong">
                <SquareDashed size={10} aria-hidden />
              </span>
            ) : null}
            {removable ? (
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
  fromNode,
}: ConnectionLineComponentProps) {
  const arrow = isAnnotationHandle(fromHandle?.id);
  // It's drawn above the nodes, so it starts at its port's outer edge (where React Flow hands it
  // over) rather than its centre: it never covers the port's circle.
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  return (
    <g>
      {arrow || !fromHandle ? null : (
        <GroupLines
          fromNodeId={fromNode.id}
          fromHandleId={fromHandle.id ?? ""}
          side={fromHandle.type}
          toX={toX}
          toY={toY}
          toPosition={toPosition}
        />
      )}
      <path d={path} fill="none" className={arrow ? "of-arrow of-pending-arrow" : "of-pending"} />
      <circle cx={toX} cy={toY} r={4} className="of-pending-ring" />
    </g>
  );
}
