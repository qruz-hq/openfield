import {
  ANNOTATION_SIDES,
  type AnnotationSide,
  annotationSourceHandle,
  annotationTargetHandle,
} from "@openfield/canvas/engine/types";
import { cn } from "@openfield/ui";
import { Handle, Position } from "@xyflow/react";
import { type CSSProperties, memo } from "react";
import { useEditorUiOptional } from "./session";

// The eight arrow handles every node carries (§7.5): a source and a target on each side, for
// annotation arrows only. Arrows start from notes, text, shapes and frames; any node can receive
// one, and its targets only wake up while an arrow is being dragged, so they never get in the way of
// the data ports that share the left and right edges.

/**
 * The left and right pairs sit this far outside the node, clear of the data ports on those edges,
 * so a drop on a port never lands on an arrow handle at the same spot.
 */
const SIDE_OFFSET = 20;
const OFFSET: Partial<Record<AnnotationSide, CSSProperties>> = {
  left: { left: -SIDE_OFFSET },
  right: { right: -SIDE_OFFSET },
};

const POSITION: Record<AnnotationSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

export interface AnnotationHandlesProps {
  /** Arrows can start here. Annotation nodes say yes; data nodes leave their edges to their ports. */
  sources?: boolean;
}

export const AnnotationHandles = memo(function AnnotationHandles({
  sources = false,
}: AnnotationHandlesProps) {
  const connecting = useEditorUiOptional((s) => s.annotationConnecting);
  return (
    <>
      {ANNOTATION_SIDES.map((side) => (
        <Handle
          key={`s-${side}`}
          type="source"
          id={annotationSourceHandle(side)}
          position={POSITION[side]}
          style={OFFSET[side]}
          isConnectable={sources}
          isConnectableEnd={false}
          className={cn("of-arrow-handle", sources && "of-arrow-handle-source")}
        />
      ))}
      {ANNOTATION_SIDES.map((side) => (
        <Handle
          key={`t-${side}`}
          type="target"
          id={annotationTargetHandle(side)}
          position={POSITION[side]}
          style={OFFSET[side]}
          isConnectable={connecting}
          isConnectableStart={false}
          className={cn("of-arrow-handle of-arrow-handle-target", connecting && "of-arrow-handle-live")}
        />
      ))}
    </>
  );
});
