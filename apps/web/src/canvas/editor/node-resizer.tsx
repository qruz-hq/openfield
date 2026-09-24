import { NodeResizer } from "@xyflow/react";
import { memo } from "react";
import type { Size } from "../store";
import { useCanvas, useReadOnly } from "../store";

// The selection handles (design ENaei c0Iy0): 8 px squares at the corners, accent-fg fill with a
// 1.5 px accent line, radius 2. The edges resize too, with no visible line: the node draws its own
// selected outline. Resizes reach the store through the editor's node change handler. One node at a
// time: in a multi-selection only the outlines show (design doZgF).

export interface CanvasNodeResizerProps {
  selected: boolean;
  minSize?: Size;
  keepAspectRatio?: boolean;
}

export const CanvasNodeResizer = memo(function CanvasNodeResizer({
  selected,
  minSize,
  keepAspectRatio,
}: CanvasNodeResizerProps) {
  const readOnly = useReadOnly();
  const alone = useCanvas((s) => s.selection.nodeIds.length <= 1);
  return (
    <NodeResizer
      isVisible={selected && alone && !readOnly}
      minWidth={minSize?.w ?? 40}
      minHeight={minSize?.h ?? 40}
      keepAspectRatio={keepAspectRatio}
      handleClassName="of-resize-handle"
      lineClassName="of-resize-line"
    />
  );
});
