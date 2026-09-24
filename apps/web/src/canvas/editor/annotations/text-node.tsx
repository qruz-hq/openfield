import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { TextCursor } from "lucide-react";
import { memo } from "react";
import { defineNode, type NodeComponentProps } from "../../nodes/registry";
import { useNodeParams } from "../../store";
import { AnnotationHandles } from "../annotation-handles";
import { EditableText, useEditingText } from "./editable-text";

// Text (design BnFrd): 16/500 $text-primary with 2 px above and below, no box. It grows with its
// words, so it has no saved size and no resize handles.

export interface TextParams {
  text: string;
}

const TextNode = memo(function TextNode({ id, selected }: NodeComponentProps) {
  const params = useNodeParams(id);
  const text = typeof params?.text === "string" ? params.text : "";
  const { start } = useEditingText(id);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Enter starts editing from the keyboard (use-shortcuts).
    <div
      onDoubleClick={start}
      className={cn(
        "min-w-8 rounded-4 py-2 text-text-primary",
        selected && "outline-2 outline-offset-4 outline-accent",
      )}
    >
      <EditableText
        id={id}
        value={text}
        placeholder={t("canvas.editor.annotations.textPlaceholder")}
        autoWidth
        className="text-[16px] leading-[19px] font-medium"
      />
      <AnnotationHandles sources />
    </div>
  );
});

export const textNode = defineNode<TextParams>({
  type: "text",
  typeVersion: 1,
  label: "canvas.editor.annotations.text",
  description: "canvas.editor.annotations.textLine",
  keywords: ["heading", "label", "title"],
  icon: TextCursor,
  category: "annotation",
  // From the toolbar (T) only.
  menu: null,
  size: null,
  resizable: false,
  annotation: true,
  ports: [],
  defaults: () => ({ text: "" }),
  parseParams: (raw) => ({ text: typeof raw.text === "string" ? raw.text : "" }),
  runnable: false,
  Component: TextNode,
});
