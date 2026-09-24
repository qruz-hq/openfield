import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { ChevronDown, ChevronRight, Frame } from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useRef, useState } from "react";
import { defineNode, type NodeComponentProps } from "../../nodes/registry";
import { useCanvas, useCanvasActions, useNodeFrame, useReadOnly, useUi } from "../../store";
import { AnnotationHandles } from "../annotation-handles";
import { CanvasNodeResizer } from "../node-resizer";
import { useEditingText } from "./editable-text";

// Frame (design sV9Pa): a titled area that groups nodes. 640×420, a 1 px $border-strong line at
// radius 16 over an $elevated tint at half strength. The title pill hangs 32 above the top-left:
// collapse chevron, name, node count. Nodes inside are React Flow children (parentId), so moving
// the frame moves them; collapsing folds it to a strip and hides them.

const FRAME_MIN = { w: 160, h: 120 };

const FrameNode = memo(function FrameNode({ id, selected }: NodeComponentProps) {
  const frame = useNodeFrame(id);
  const count = useCanvas((s) => {
    let n = 0;
    for (const child of s.doc.order) if (s.doc.nodes[child]?.parentId === id) n++;
    return n;
  });
  const actions = useCanvasActions();
  const readOnly = useReadOnly();
  const collapsed = frame?.collapsed ?? false;
  const title = frame?.title ?? t("canvas.editor.annotations.frame");
  const { editing, start } = useEditingText(id);

  const toggle = () => {
    actions.apply([{ op: "setCollapsed", id, collapsed: !collapsed }], { label: "collapse" });
  };

  return (
    <div className="relative size-full">
      <div className="absolute inset-0 rounded-16 bg-elevated opacity-50" />
      <div
        className={cn(
          "absolute inset-0 rounded-16",
          selected ? "inset-ring-2 inset-ring-accent" : "inset-ring inset-ring-border-strong",
        )}
      />
      <div className="absolute -top-32 left-0 flex h-24 max-w-full items-center gap-6 rounded-8 bg-elevated-2 px-8 inset-ring inset-ring-border">
        <button
          type="button"
          aria-label={t(collapsed ? "canvas.editor.frame.expand" : "canvas.editor.frame.collapse")}
          aria-expanded={!collapsed}
          disabled={readOnly}
          onClick={toggle}
          className="nodrag -m-2 inline-flex shrink-0 cursor-pointer rounded-4 p-2 text-text-tertiary hover:text-text-secondary disabled:cursor-default"
        >
          {collapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        </button>
        {editing ? (
          <TitleInput id={id} initial={frame?.title ?? ""} placeholder={title} />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: Enter renames from the keyboard (use-shortcuts).
          <span onDoubleClick={start} className="min-w-0 truncate text-caption font-medium text-text-primary">
            {title}
          </span>
        )}
        <span className="shrink-0 text-caption text-text-tertiary">
          {t("canvas.editor.frame.count", { count })}
        </span>
      </div>
      {collapsed ? null : <CanvasNodeResizer selected={selected} minSize={FRAME_MIN} />}
      <AnnotationHandles sources />
    </div>
  );
});

function TitleInput({ id, initial, placeholder }: { id: string; initial: string; placeholder: string }) {
  const actions = useCanvasActions();
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const ui = useUi((u) => u.renamingNodeId);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.trim();
    if (commit && next !== initial.trim()) {
      actions.apply([{ op: "setTitle", id, title: next || null }], { label: "rename" });
    }
    if (ui === id) actions.setUi({ renamingNodeId: null });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-label={t("canvas.editor.frame.name")}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={onKeyDown}
      maxLength={200}
      className="nodrag w-160 min-w-0 bg-transparent text-caption font-medium text-text-primary outline-none"
    />
  );
}

export const frameNode = defineNode<Record<string, never>>({
  type: "frame",
  typeVersion: 1,
  label: "canvas.editor.annotations.frame",
  description: "canvas.editor.annotations.frameLine",
  keywords: ["group", "section", "area"],
  icon: Frame,
  category: "annotation",
  menu: { group: "utilities", order: 2 },
  size: { w: 640, h: 420 },
  minSize: FRAME_MIN,
  resizable: true,
  annotation: true,
  ports: [],
  defaults: () => ({}),
  parseParams: () => ({}),
  runnable: false,
  Component: FrameNode,
});
