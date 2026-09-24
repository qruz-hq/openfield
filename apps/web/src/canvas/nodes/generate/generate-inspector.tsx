import { t } from "@openfield/core";
import { Badge, cn, Divider, IconButton, MiniChip, Stepper } from "@openfield/ui";
import { ChevronDown, Link, Plus, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { UPLOAD_ACCEPT, uploadImages } from "../../../api/hooks/uploads";
import { errorMessage } from "../../../api/raw";
import { clampBatch } from "../../../lib/controls";
import { notifyError } from "../../../lib/notify";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { modelKeyOf, modelsFitting } from "../../engine/inputs";
import { useCanvasStoreApi, useNodeFrame, useReadOnly } from "../../store/context";
import { incomingEdges, newEdgeId, newNodeId } from "../../store/graph";
import { InspectorRun, ModelField, SizeField } from "../shell/inspector-parts";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";
import { uploadSpec } from "../upload/spec";
import { sizeControls, useModelSwitch } from "./controls";
import { ReferenceOrder } from "./reference-order";
import { SeedField } from "./seed-field";
import { type GenerateParams, generateSpec } from "./spec";

// Generate's settings (design AWQzm): the prompt card (add a reference, the node's own words, the
// words coming in from a Prompt node), the model, the size fields, how many images, the Advanced
// row (the seed, and later each model's extras), then Run.

/** Where a reference added from here goes: to the left of the node, like the design's graphs. */
const REFERENCE_GAP = 80;

export function GenerateInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const frame = useNodeFrame(nodeId);
  const params = useParsedParams<GenerateParams>(nodeId, generateSpec, ctx);
  const setParams = useSetParams(nodeId);
  const switchModel = useModelSwitch(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const store = useCanvasStoreApi();
  const readOnly = useReadOnly();
  const files = useRef<HTMLInputElement>(null);
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const controls = useMemo(() => sizeControls(model, params), [model, params]);
  const upstream = analysis?.upstreamText ?? "";
  const busy = display.state === "queued" || display.state === "running";

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

  if (!frame) return null;
  return (
    <>
      <div className="flex w-full flex-col gap-12 rounded-14 bg-surface p-12">
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
        <IconButton
          variant="secondary"
          size={32}
          icon={Plus}
          label={t("canvas.nodes.generate.addReference")}
          disabled={readOnly || !model?.capabilities.references.supported}
          onClick={() => files.current?.click()}
        />
        <textarea
          value={params.prompt}
          readOnly={readOnly}
          rows={2}
          placeholder={t("canvas.nodes.generate.promptPlaceholder")}
          aria-label={t("canvas.nodes.generate.promptField")}
          onChange={(event) => setParams({ prompt: event.target.value }, "prompt")}
          onKeyDown={(event) => event.stopPropagation()}
          className="field-sizing-content max-h-200 min-h-20 w-full resize-none bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {upstream ? (
          <MiniChip
            icon={Link}
            label={<span className="block max-w-280 truncate">{upstream}</span>}
            aria-label={t("canvas.nodes.generate.fromPrompt")}
            title={t("canvas.nodes.generate.fromPrompt")}
            onClick={focusPromptNode}
            className="self-start"
          />
        ) : null}
      </div>
      <ReferenceOrder nodeId={nodeId} />
      <ModelField
        models={modelsFitting(ctx.models, { references: analysis?.references ?? 0 }, key)}
        selected={model}
        disabled={readOnly}
        onSelect={(next) => {
          if (next.key !== model?.key) switchModel(model, next, params);
        }}
      />
      {controls.length ? (
        <div className="grid w-full grid-cols-2 gap-8">
          {controls.map((control) => (
            <SizeField
              key={control.id}
              control={control}
              disabled={readOnly}
              onPick={(value) => setParams(control.patch(value))}
            />
          ))}
        </div>
      ) : null}
      <div className="flex w-full items-center justify-between px-2">
        <span className="text-small font-medium text-text-primary">{t("canvas.nodes.inspector.images")}</span>
        <Stepper
          value={model ? clampBatch(model.capabilities, params.batch) : params.batch}
          min={1}
          max={model?.capabilities.batch.max ?? 4}
          disabled={readOnly}
          onValueChange={(batch) => setParams({ batch }, "batch")}
          decrementLabel={t("canvas.nodes.inspector.fewer")}
          incrementLabel={t("canvas.nodes.inspector.more")}
          aria-label={t("canvas.nodes.inspector.images")}
        />
      </div>
      <Divider />
      <Advanced changed={params.seed.mode === "fixed" ? 1 : 0}>
        <SeedField
          model={model}
          seed={params.seed}
          disabled={readOnly}
          onChange={(seed) => setParams({ seed }, "seed")}
        />
      </Advanced>
      <InspectorRun
        estimate={analysis?.estimate ?? null}
        disabled={readOnly || busy}
        onRun={(anchor, bypassCache) => void run("node", { anchor, bypassCache })}
      />
    </>
  );
}

/** Advanced (design iWF7C): a 32-tall row that opens what's inside, with how many differ from the default. */
function Advanced({ changed, children }: { changed: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((was) => !was)}
        className="flex h-32 w-full cursor-pointer items-center gap-8 px-2 text-left"
      >
        <SlidersHorizontal size={14} aria-hidden className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 text-small font-medium text-text-primary">
          {t("canvas.nodes.inspector.advanced")}
        </span>
        {changed ? (
          <Badge variant="count" aria-label={t("canvas.nodes.inspector.changed", { count: changed })}>
            {changed}
          </Badge>
        ) : null}
        <ChevronDown
          size={14}
          aria-hidden
          className={cn("shrink-0 text-text-tertiary transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div id={panel} className="flex w-full flex-col gap-12">
          {children}
        </div>
      ) : null}
    </>
  );
}
