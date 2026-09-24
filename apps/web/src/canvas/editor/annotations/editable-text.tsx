import { cn } from "@openfield/ui";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { useCanvasActions, useCanvasStoreApi, useReadOnly, useUi } from "../../store";

// In-place text for annotation nodes. Double-click (or placing a new one) starts editing; Escape
// or clicking away ends it. Each keystroke is a param change that coalesces into one undo entry.

export function useEditingText(id: string) {
  const editing = useUi((ui) => ui.renamingNodeId === id);
  const readOnly = useReadOnly();
  const actions = useCanvasActions();
  return {
    editing: editing && !readOnly,
    start: () => {
      if (!readOnly) actions.setUi({ renamingNodeId: id });
    },
  };
}

export function useSetText(id: string, field = "text") {
  const actions = useCanvasActions();
  return (value: string) =>
    actions.apply([{ op: "setParams", id, patch: { [field]: value } }], {
      coalesce: `param:${id}:${field}`,
      label: "text",
    });
}

export interface EditableTextProps {
  id: string;
  value: string;
  placeholder: string;
  className?: string;
  /** Grows with its content: a single line per line typed, never wrapping (Text). */
  autoWidth?: boolean;
  /** Fills the node and scrolls (Note), instead of growing. */
  fill?: boolean;
  align?: "left" | "center";
}

export function EditableText({
  id,
  value,
  placeholder,
  className,
  autoWidth = false,
  fill = false,
  align = "left",
}: EditableTextProps) {
  const { editing } = useEditingText(id);
  const setText = useSetText(id);
  const store = useCanvasStoreApi();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    // A node sized by its content stays hidden until React Flow has measured it, and a hidden field
    // can't take focus, so keep trying for a few frames.
    let frame = 0;
    let tries = 0;
    const focus = () => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (document.activeElement === el) el.setSelectionRange(el.value.length, el.value.length);
      else if (tries++ < 10) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const stop = () => {
    const { ui, actions } = store.getState();
    if (ui.renamingNodeId === id) actions.setUi({ renamingNodeId: null });
    actions.sealHistory();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stop();
      ref.current?.blur();
    }
  };

  const shown = value || placeholder;
  const textClass = cn(
    "whitespace-pre-wrap break-words",
    autoWidth && "whitespace-pre",
    align === "center" && "text-center",
    className,
  );

  if (!editing) {
    return (
      <div className={cn(textClass, !value && "text-text-tertiary", fill && "size-full overflow-hidden")}>
        {shown}
      </div>
    );
  }

  const textarea = (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      rows={1}
      spellCheck
      onChange={(e) => setText(e.target.value)}
      onBlur={stop}
      onKeyDown={onKeyDown}
      className={cn(
        textClass,
        "nodrag nowheel nopan block resize-none bg-transparent p-0 outline-none placeholder:text-text-tertiary",
        fill ? "size-full overflow-auto" : "overflow-hidden",
      )}
    />
  );
  if (fill) return textarea;
  // The mirror span sizes the box to the text, so the field grows as you type.
  return (
    <div className="grid [&>*]:[grid-area:1/1]">
      <span aria-hidden className={cn(textClass, "invisible")}>
        {`${value || placeholder} `}
      </span>
      {textarea}
    </div>
  );
}
