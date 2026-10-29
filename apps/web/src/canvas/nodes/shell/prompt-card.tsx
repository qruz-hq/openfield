import { uploadSpec } from "@openfield/canvas/nodes/upload/spec";
import { incomingEdges, newEdgeId, newNodeId } from "@openfield/canvas/store/graph";
import { t } from "@openfield/core";
import { cn, IconButton, MiniChip } from "@openfield/ui";
import { Link, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { UPLOAD_ACCEPT, uploadImages } from "../../../api/hooks/uploads";
import { errorMessage } from "../../../api/raw";
import { notifyError } from "../../../lib/notify";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useCanvasStoreApi, useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { ReferenceOrder, type ReferenceThumbSize } from "../generate/reference-order";
import { LOCKED_DIM } from "./inspector-parts";
import { LinkedPrompt } from "./linked-text";

// The prompt card of a node's settings (design AWQzm, iy0ZN; Edit's MZI3JqbHJr): the reference
// images coming in and the + that adds one, the whole prompt coming in from a Prompt node, the
// node's own words, and the chip that leads to that Prompt node. Generate and Edit share it; Edit's
// thumbnails are 56, and its words come from the Prompt node alone while one is linked.

/** Where a reference added from here goes: to the left of the node, like the design's graphs. */
const REFERENCE_GAP = 80;

export interface PromptCardProps {
  nodeId: string;
  /** The node's own words. */
  value: string;
  onChange: (value: string) => void;
  /** The model takes reference images: the + adds one. */
  references: boolean;
  placeholder: string;
  /** The text field's name. */
  fieldLabel: string;
  /** The chip under the words coming in ("From the Prompt node"). */
  fromLabel: string;
  /** The reference thumbnails' side. */
  thumbSize?: ReferenceThumbSize;
  /**
   * The node's own words can be added to those coming in (Generate). Off, a linked prompt stands
   * alone (Edit, MZI3JqbHJr): the field shows only while it still holds words typed before.
   */
  addToLinked?: boolean;
}

export function PromptCard({
  nodeId,
  value,
  onChange,
  references,
  placeholder,
  fieldLabel,
  fromLabel,
  thumbSize = 32,
  addToLinked = true,
}: PromptCardProps) {
  const frame = useNodeFrame(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const store = useCanvasStoreApi();
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const files = useRef<HTMLInputElement>(null);
  const upstream = analysis?.upstreamText ?? "";
  // Cleared while linked, the field stays until it loses focus, so it doesn't vanish mid-edit.
  const [editing, setEditing] = useState(false);
  const field = !upstream || addToLinked || value !== "" || editing;

  const focusPromptNode = () => {
    const state = store.getState();
    const source = incomingEdges(state.doc, nodeId, "prompt")[0]?.source;
    if (!source) return;
    state.actions.setSelection({ nodeIds: [source], edgeIds: [] });
    state.viewController.focusNode(source);
  };

  /** Uploads the files into a new Upload node wired into this node's references. */
  const addReference = async (list: File[]) => {
    if (!list.length || !frame) return;
    const { assetIds, failed } = await uploadImages(list);
    for (const { error } of failed) notifyError(errorMessage(error));
    if (!assetIds.length) return;
    const width = uploadSpec.size!.w;
    const node = {
      id: newNodeId(),
      type: uploadSpec.type,
      typeVersion: uploadSpec.typeVersion,
      position: { x: frame.position.x - width - REFERENCE_GAP, y: frame.position.y },
      size: { ...uploadSpec.size! },
      parentId: frame.parentId,
      collapsed: false,
      title: null,
      params: { assetIds },
      presetLocks: [],
      result: null,
    };
    store.getState().actions.apply(
      [
        { op: "addNode", node },
        {
          op: "addEdge",
          edge: {
            id: newEdgeId(),
            source: node.id,
            sourceHandle: "images",
            target: nodeId,
            targetHandle: "input_images",
            kind: "data",
          },
        },
      ],
      { label: "reference" },
    );
  };

  return (
    <div className={cn("flex w-full flex-col gap-12 rounded-14 bg-surface p-12", locked && LOCKED_DIM)}>
      <input
        ref={files}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          void addReference([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {/* The references come in first, then the + that adds one (design iy0ZN). */}
      <div className="flex flex-wrap items-center gap-6">
        <ReferenceOrder nodeId={nodeId} size={thumbSize} />
        <IconButton
          variant="secondary"
          size={32}
          icon={Plus}
          label={t("canvas.nodes.generate.addReference")}
          disabled={readOnly || locked || !references}
          // Locked, the + keeps its look inside the dimmed card.
          className={locked && references ? "disabled:text-inherit" : undefined}
          onClick={() => files.current?.click()}
        />
      </div>
      {/* The whole prompt coming in, then this node's own words after it. */}
      {upstream ? (
        <p className="w-full text-small leading-[1.5] break-words whitespace-pre-wrap text-text-primary">
          <LinkedPrompt parts={analysis?.upstreamParts ?? []} own="" />
        </p>
      ) : null}
      {field ? (
        <textarea
          value={value}
          readOnly={readOnly || locked}
          rows={2}
          // Locked, nothing can be added, so nothing asks for it.
          placeholder={locked ? undefined : placeholder}
          aria-label={fieldLabel}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => event.stopPropagation()}
          className="field-sizing-content max-h-200 min-h-20 w-full resize-none bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      ) : null}
      {upstream ? (
        <MiniChip icon={Link} label={fromLabel} onClick={focusPromptNode} className="self-start" />
      ) : null}
    </div>
  );
}
