import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { StickyNote } from "lucide-react";
import { memo } from "react";
import { defineNode, type NodeComponentProps } from "../../nodes/registry";
import { useNodeParams } from "../../store";
import { AnnotationHandles } from "../annotation-handles";
import { CanvasNodeResizer } from "../node-resizer";
import { EditableText, useEditingText } from "./editable-text";

// Note (design LFiZS): 240×240, padding 16, a warm sticky (--of-note, editor.css: the design's two
// $accent-soft layers in dark) with an $accent-line edge, radius 8, text 15/500 at 1.45. No label
// and no data ports.

export interface NoteParams {
  text: string;
  /** Kept for the tint choices §7.5 lists; the design draws one, so only that renders (§8.7). */
  tint: number;
}

const NOTE_MIN = { w: 120, h: 80 };

const NoteNode = memo(function NoteNode({ id, selected, lod }: NodeComponentProps) {
  const params = useNodeParams(id);
  const text = typeof params?.text === "string" ? params.text : "";
  const { start } = useEditingText(id);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Enter starts editing from the keyboard (use-shortcuts).
    <div
      onDoubleClick={start}
      className={cn(
        "flex size-full flex-col rounded-8 p-16 text-text-primary",
        "bg-[var(--of-note)]",
        selected ? "inset-ring-2 inset-ring-accent" : "inset-ring inset-ring-accent-line",
      )}
    >
      {lod === "rect" ? null : (
        <EditableText
          id={id}
          value={text}
          placeholder={t("canvas.editor.annotations.notePlaceholder")}
          fill
          className="text-[15px] leading-[1.45] font-medium"
        />
      )}
      <CanvasNodeResizer selected={selected} minSize={NOTE_MIN} />
      <AnnotationHandles sources />
    </div>
  );
});

export const noteNode = defineNode<NoteParams>({
  type: "note",
  typeVersion: 1,
  label: "canvas.editor.annotations.note",
  description: "canvas.editor.annotations.noteLine",
  keywords: ["sticky", "comment", "annotation"],
  icon: StickyNote,
  category: "annotation",
  menu: { group: "utilities", order: 1 },
  size: { w: 240, h: 240 },
  minSize: NOTE_MIN,
  resizable: true,
  annotation: true,
  ports: [],
  defaults: () => ({ text: "", tint: 0 }),
  parseParams: (raw) => ({
    text: typeof raw.text === "string" ? raw.text : "",
    tint: typeof raw.tint === "number" && Number.isFinite(raw.tint) ? raw.tint : 0,
  }),
  runnable: false,
  Component: NoteNode,
});
