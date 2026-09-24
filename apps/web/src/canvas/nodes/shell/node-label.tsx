import { t } from "@openfield/core";
import { Tooltip } from "@openfield/ui";
import { useEffect, useRef, useState } from "react";
import { useCanvasActions, useReadOnly, useUi } from "../../store/context";

// Canvas / Node / Label (design JXox3): 22 above the frame, 12/500 in $text-secondary, with the
// accent dot when the node's inputs changed. Double-click (or Rename in the node menu) edits it
// in place; an empty name goes back to the type's own.

export interface NodeLabelProps {
  id: string;
  title: string | null;
  fallback: string;
  changed: boolean;
  /** ×k when a list runs this node once per image (§7.7). */
  fanOut: number;
}

export function NodeLabel({ id, title, fallback, changed, fanOut }: NodeLabelProps) {
  const renaming = useUi((ui) => ui.renamingNodeId === id);
  const readOnly = useReadOnly();
  const actions = useCanvasActions();
  const shown = title?.trim() || fallback;

  return (
    <div className="absolute top-[-22px] left-0 flex h-15 max-w-full items-center gap-6">
      {changed ? (
        <span
          role="img"
          aria-label={t("canvas.nodes.label.changed")}
          className="size-6 shrink-0 rounded-full bg-accent"
        />
      ) : null}
      {renaming && !readOnly ? (
        <RenameField
          initial={title ?? ""}
          placeholder={fallback}
          onDone={(next) => {
            actions.setUi({ renamingNodeId: null });
            if (next === null) return;
            const value = next.trim() || null;
            if (value !== title) actions.apply([{ op: "setTitle", id, title: value }]);
          }}
        />
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("canvas.nodes.label.rename", { name: shown })}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!readOnly) actions.setUi({ renamingNodeId: id });
          }}
          className="min-w-0 cursor-default truncate text-left text-caption font-medium text-text-secondary"
        >
          {shown}
        </button>
      )}
      {fanOut > 1 ? (
        <Tooltip content={t("canvas.nodes.pill.fanOut", { count: fanOut })}>
          <span className="flex h-18 shrink-0 items-center rounded-full bg-elevated-2 px-6 text-mono-11 font-medium text-text-secondary">
            ×{fanOut}
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}

function RenameField({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  /** null: canceled. */
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(next);
  };
  return (
    <input
      ref={input}
      value={value}
      maxLength={200}
      placeholder={placeholder}
      aria-label={t("canvas.nodes.label.rename", { name: placeholder })}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(value);
        else if (event.key === "Escape") finish(null);
      }}
      className="nodrag h-15 min-w-80 bg-transparent text-caption font-medium text-text-primary outline-none placeholder:text-text-tertiary"
    />
  );
}
