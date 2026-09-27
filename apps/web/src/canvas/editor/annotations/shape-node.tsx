import { SHAPE_MIN, shapeSpec } from "@openfield/canvas/nodes/annotations";
import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { Square } from "lucide-react";
import { memo } from "react";
import { defineNode, type NodeComponentProps } from "../../nodes/registry";
import { useNodeParams } from "../../store";
import { AnnotationHandles } from "../annotation-handles";
import { CanvasNodeResizer } from "../node-resizer";
import { EditableText, useEditingText } from "./editable-text";

// Shape. The design has no node for it yet; this is the plan's proposal from kit values: a
// 210×126 rectangle on $elevated-2 with a 1 px $border-strong line, radius 8, and a centred
// 14/500 label. Only rectangles for now; `shape` is saved so more can follow.

const ShapeNode = memo(function ShapeNode({ id, selected, lod }: NodeComponentProps) {
  const params = useNodeParams(id);
  const text = typeof params?.text === "string" ? params.text : "";
  const { start, editing } = useEditingText(id);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Enter starts editing from the keyboard (use-shortcuts).
    <div
      onDoubleClick={start}
      className={cn(
        "flex size-full items-center justify-center rounded-8 bg-elevated-2 p-12 text-text-primary",
        selected ? "inset-ring-2 inset-ring-accent" : "inset-ring inset-ring-border-strong",
      )}
    >
      {lod === "rect" || (!text && !editing) ? null : (
        <div className="min-w-0 max-w-full">
          <EditableText
            id={id}
            value={text}
            placeholder={t("canvas.editor.annotations.shapePlaceholder")}
            align="center"
            className="text-body-medium"
          />
        </div>
      )}
      <CanvasNodeResizer selected={selected} minSize={SHAPE_MIN} />
      <AnnotationHandles sources />
    </div>
  );
});

export const shapeNode = defineNode({ ...shapeSpec, icon: Square, Component: ShapeNode });
