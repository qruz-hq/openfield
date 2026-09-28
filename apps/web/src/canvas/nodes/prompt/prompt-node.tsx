import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { PROMPT_MAX, type PromptParams, promptSpec } from "@openfield/canvas/nodes/prompt/spec";
import { t } from "@openfield/core";
import { memo, useEffect, useRef } from "react";
import { useLocked, useReadOnly } from "../../store/context";
import { takeOpenPicker } from "../picker-intent";
import type { NodeComponentProps } from "../registry";
import { leaveField } from "../shell/focus";
import { NodeShell } from "../shell/node-shell";
import { useNodeBasics, useParsedParams, useSetParams } from "../shell/use-node";

// Canvas / Node / Prompt (design pFPMj): 8 padding around a Surface / Block (w6khK) with the text
// (13/1.5) and the mono count "70 / 4000" at the bottom.

export const PromptNode = memo(function PromptNode(props: NodeComponentProps) {
  const basics = useNodeBasics(props.id);
  const params = useParsedParams<PromptParams>(props.id, promptSpec, basics?.ctx ?? EMPTY_ENGINE_CONTEXT);
  const setParams = useSetParams(props.id);
  const readOnly = useReadOnly();
  // A locked Prompt node keeps its words (§7.9).
  const locked = useLocked(props.id);
  const field = useRef<HTMLTextAreaElement>(null);
  // Just added from a menu: ready to type into.
  useEffect(() => {
    if (takeOpenPicker(props.id)) field.current?.focus();
  }, [props.id]);
  if (!basics) return null;
  const { frame } = basics;
  const text = params.text;

  return (
    <NodeShell
      {...props}
      spec={promptSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      collapsedMeta={
        <span className="truncate text-caption text-text-secondary">
          {text.trim() || t("canvas.nodes.prompt.placeholder")}
        </span>
      }
      thumbs={[]}
      frameClassName="p-8"
    >
      <div className="flex min-h-0 flex-1 flex-col justify-between gap-8 rounded-14 bg-surface p-12">
        <textarea
          ref={field}
          value={text}
          maxLength={PROMPT_MAX}
          readOnly={readOnly || locked}
          placeholder={t("canvas.nodes.prompt.placeholder")}
          aria-label={t("canvas.nodes.prompt.field")}
          spellCheck
          onChange={(event) => setParams({ text: event.target.value }, "text")}
          onKeyDown={(event) => {
            // Keys typed here are text, not canvas shortcuts.
            event.stopPropagation();
            // Back to the node itself, so the keyboard carries on from there.
            if (event.key === "Escape") leaveField(event.currentTarget);
          }}
          className="nodrag nowheel min-h-0 w-full flex-1 resize-none bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <span className="shrink-0 text-mono-11 text-text-tertiary">
          {/* Plain digits, as designed: "70 / 4000". */}
          {t("canvas.nodes.prompt.count", { count: String(text.length), max: String(PROMPT_MAX) })}
        </span>
      </div>
    </NodeShell>
  );
});
