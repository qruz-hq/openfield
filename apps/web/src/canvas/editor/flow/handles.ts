import {
  ANNOTATION_SIDES,
  type AnnotationSide,
  annotationSourceHandle,
  annotationTargetHandle,
  type PortSpec,
} from "@openfield/canvas/engine/types";
import { type NodeHandle, Position } from "@xyflow/react";
import { railLayout } from "../../nodes/shell/rail";

// Where each node's handles are, worked out from its box the way the DOM lays them out, and handed
// to React Flow with the node. React Flow then draws links to a node it hasn't measured (or mounted)
// yet, and never measures a node whose size we already know.

/** Ports are 24 px circles centred on the node's side (nodes.css .of-port). */
const PORT_SIZE = 24;
/** Arrow handles are 10 px circles (editor.css .of-arrow-handle). */
const ARROW_SIZE = 10;
/** The left and right arrow handles sit this far outside the node (annotation-handles.tsx). */
const ARROW_SIDE_OFFSET = 20;

const ARROW_POSITION: Record<AnnotationSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/** An arrow handle's top-left corner in the node, for a w × h node. */
function arrowCorner(side: AnnotationSide, w: number, h: number): { x: number; y: number } {
  const half = ARROW_SIZE / 2;
  switch (side) {
    case "top":
      return { x: w / 2 - half, y: -half };
    case "bottom":
      return { x: w / 2 - half, y: h - half };
    case "left":
      return { x: -ARROW_SIDE_OFFSET - half, y: h / 2 - half };
    case "right":
      return { x: w + ARROW_SIDE_OFFSET - half, y: h / 2 - half };
  }
}

/**
 * Every handle a node of this size draws: its visible data ports (inputs on the left, outputs on the
 * right, offsets from railLayout, all on the middle when collapsed) and the eight arrow handles.
 */
export function nodeHandles(
  ports: readonly PortSpec[],
  w: number,
  h: number,
  collapsed = false,
): NodeHandle[] {
  const out: NodeHandle[] = [];
  const half = PORT_SIZE / 2;
  for (const direction of ["in", "out"] as const) {
    for (const { port, offset } of railLayout(ports, direction)) {
      out.push({
        id: port.id,
        type: direction === "in" ? "target" : "source",
        position: direction === "in" ? Position.Left : Position.Right,
        x: direction === "in" ? -half : w - half,
        y: h / 2 + (collapsed ? 0 : offset) - half,
        width: PORT_SIZE,
        height: PORT_SIZE,
      });
    }
  }
  for (const side of ANNOTATION_SIDES) {
    const corner = arrowCorner(side, w, h);
    const position = ARROW_POSITION[side];
    const size = { width: ARROW_SIZE, height: ARROW_SIZE };
    out.push({ id: annotationSourceHandle(side), type: "source", position, ...corner, ...size });
    out.push({ id: annotationTargetHandle(side), type: "target", position, ...corner, ...size });
  }
  return out;
}
