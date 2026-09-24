import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { CircleHelp } from "lucide-react";
import { memo } from "react";
import { isAnnotationHandle } from "../../engine/types";
import { railOffsets } from "../../nodes/registry";
import { useCanvasShallow, useNodeFrame } from "../../store";
import { AnnotationHandles } from "../annotation-handles";

// A node whose type this build doesn't know: saved by a newer Openfield, or one whose feature isn't
// here yet. It keeps its place, its data and its connections, and saves back untouched. It draws a
// handle for every connection that touches it so those still show.

export const UnknownNode = memo(function UnknownNode({ id, selected, height }: NodeProps) {
  const frame = useNodeFrame(id);
  const handles = useCanvasShallow((s) => {
    const out: string[] = [];
    for (const edgeId of s.doc.edgeOrder) {
      const e = s.doc.edges[edgeId];
      if (e?.kind !== "data") continue;
      if (e.source === id && !isAnnotationHandle(e.sourceHandle)) out.push(`out:${e.sourceHandle}`);
      if (e.target === id && !isAnnotationHandle(e.targetHandle)) out.push(`in:${e.targetHandle}`);
    }
    return [...new Set(out)];
  });
  const inputs = handles.filter((h) => h.startsWith("in:")).map((h) => h.slice(3));
  const outputs = handles.filter((h) => h.startsWith("out:")).map((h) => h.slice(4));
  const h = height ?? frame?.size?.h ?? 160;
  const inAt = railOffsets(inputs.length, h);
  const outAt = railOffsets(outputs.length, h);

  return (
    <div
      className={cn(
        "relative flex size-full flex-col items-center justify-center gap-8 rounded-14 border border-dashed bg-elevated p-16 text-center",
        selected ? "border-accent" : "border-border-strong",
      )}
    >
      {frame?.title ? (
        <span className="absolute -top-22 left-0 max-w-full truncate text-caption font-medium text-text-secondary">
          {frame.title}
        </span>
      ) : null}
      <CircleHelp size={16} aria-hidden className="text-text-tertiary" />
      <span className="text-small font-medium text-text-primary">{t("canvas.editor.unknownNode.title")}</span>
      <span className="text-caption text-text-tertiary">{t("canvas.editor.unknownNode.body")}</span>
      {inputs.map((port, i) => (
        <Handle
          key={`in-${port}`}
          type="target"
          id={port}
          position={Position.Left}
          isConnectable={false}
          style={{ top: inAt[i] }}
          className="of-unknown-port"
        />
      ))}
      {outputs.map((port, i) => (
        <Handle
          key={`out-${port}`}
          type="source"
          id={port}
          position={Position.Right}
          isConnectable={false}
          style={{ top: outAt[i] }}
          className="of-unknown-port"
        />
      ))}
      <AnnotationHandles />
    </div>
  );
});
