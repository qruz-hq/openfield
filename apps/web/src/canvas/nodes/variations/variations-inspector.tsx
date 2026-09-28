import { speedOf } from "@openfield/canvas/engine/context-base";
import { nodeTitle } from "@openfield/canvas/engine/describe";
import { modelKeyOf, modelsFitting } from "@openfield/canvas/engine/inputs";
import type { EngineContext } from "@openfield/canvas/engine/types";
import { carriedFor } from "@openfield/canvas/nodes/generate/settings";
import {
  LIST_MAX,
  modelList,
  promptLines,
  TAKES_MAX,
  TAKES_MIN,
  type VariationStrategy,
  type VariationsParams,
  variationsSpec,
} from "@openfield/canvas/nodes/variations/spec";
import { incomingEdges } from "@openfield/canvas/store/graph";
import { type ModelKey, t } from "@openfield/core";
import { estimateRun } from "@openfield/providers/manifest";
import { Button, MiniChip, ProviderLogo, Segmented, SegmentedItem, Stepper } from "@openfield/ui";
import { Link, Plus, Square, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { tightCost } from "../../../lib/cost";
import { logoFor } from "../../../lib/provider";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas, useCanvasStoreApi, useReadOnly } from "../../store/context";
import { sizeControls, useModelSwitch } from "../generate/controls";
import { nodeRegistry } from "../registry";
import { InspectorRun, ModelField, SizeField } from "../shell/inspector-parts";
import { type LinkEnds, LinkedPrompt, useLinkHover } from "../shell/linked-text";
import { useCancel } from "../shell/state-band";
import { AssetImage } from "../shell/thumb";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";
import { AddModelPicker } from "./add-model";
import { addRow, backspaceRow, enterRow, promptRows, removeRow, setRow } from "./prompt-rows";

// Variations' side sheet (design rD6HX New takes, xrC4Q Prompts, YWYEQ Models): what it reads (the
// incoming image and the words from a Prompt node), what it makes (New takes, Prompts or Models,
// each with its own list or count), the size every run shares, then Run. Everything the card used
// to carry under its images lives here now; the card is its images.

const STRATEGIES: { value: VariationStrategy; label: "newTakes" | "promptList" | "modelList" }[] = [
  { value: "same-prompt", label: "newTakes" },
  { value: "prompt-list", label: "promptList" },
  { value: "model-list", label: "modelList" },
];

export function VariationsInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const params = useParsedParams<VariationsParams>(nodeId, variationsSpec, ctx);
  const setParams = useSetParams(nodeId);
  const switchModel = useModelSwitch(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const cancel = useCancel(nodeId);
  const readOnly = useReadOnly();
  const byModel = params.strategy === "model-list";
  const models = modelList(params);
  // Models mode shows the first model's size options; the others clamp to theirs.
  const key = byModel ? (models[0] ?? null) : modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const speed = model ? speedOf(ctx, model) : "standard";
  const controls = useMemo(() => sizeControls(model, params, 1, speed), [model, params, speed]);
  const busy = display.state === "queued" || display.state === "running";
  const references = analysis?.references ?? 0;

  const pickStrategy = (value: string) => {
    const next = value as VariationStrategy;
    if (!value || next === params.strategy) return;
    // Models mode starts from the model the node already uses.
    const patch: Record<string, unknown> = { strategy: next };
    if (next === "model-list" && !models.length && key) patch.models = [key];
    setParams(patch);
  };

  const runLabel =
    params.strategy === "model-list"
      ? t("canvas.nodes.variations.runModels", { count: models.length })
      : params.strategy === "prompt-list"
        ? t("canvas.nodes.variations.runPrompts", { count: promptLines(params).length })
        : t("canvas.nodes.variations.runTakes", { count: params.count });

  return (
    <>
      <Reads nodeId={nodeId} />
      {/* Make (design oi7Dd): what the node varies. */}
      <div className="flex w-full flex-col gap-8 px-2 pt-4">
        <span className="text-caption text-text-tertiary">{t("canvas.nodes.variations.make")}</span>
        <Segmented
          value={params.strategy}
          onValueChange={pickStrategy}
          disabled={readOnly}
          aria-label={t("canvas.nodes.variations.strategy")}
        >
          {STRATEGIES.map((s) => (
            <SegmentedItem key={s.value} value={s.value}>
              {t(`canvas.nodes.variations.${s.label}`)}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      {byModel ? null : (
        <ModelField
          models={modelsFitting(ctx.models, { references }, key)}
          selected={model}
          disabled={readOnly}
          onSelect={(next) => {
            if (next.key !== model?.key) switchModel(model, next, params);
          }}
        />
      )}
      {params.strategy === "same-prompt" ? (
        // Takes (design X6GHv): the count and what a take is.
        <div className="flex w-full items-center justify-between gap-12 px-2">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-small font-medium text-text-primary">
              {t("canvas.nodes.variations.takes")}
            </span>
            <span className="text-caption text-text-tertiary">{t("canvas.nodes.variations.takesHint")}</span>
          </div>
          <Stepper
            value={params.count}
            min={TAKES_MIN}
            max={TAKES_MAX}
            disabled={readOnly}
            onValueChange={(count) => setParams({ count }, "count")}
            decrementLabel={t("canvas.nodes.variations.fewer")}
            incrementLabel={t("canvas.nodes.variations.more")}
            aria-label={t("canvas.nodes.variations.takes")}
          />
        </div>
      ) : params.strategy === "prompt-list" ? (
        <PromptList
          prompts={params.prompts}
          readOnly={readOnly}
          onChange={(prompts) => setParams({ prompts }, "prompts")}
        />
      ) : (
        <ModelList
          ctx={ctx}
          params={params}
          readOnly={readOnly}
          references={references}
          onChange={(next) => setParams({ models: next })}
        />
      )}
      {controls.length ? (
        // Size row (design MUCJI): resolution or quality, then aspect ratio, sharing the width.
        <div className="flex w-full gap-8">
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
      {busy ? (
        // While it runs, Run gives way to Stop (Cancel while it waits), like the card's bar.
        <Button
          variant="secondary"
          size="m"
          icon={display.state === "queued" ? X : Square}
          disabled={readOnly}
          className="w-full"
          onClick={() => cancel()}
        >
          {display.state === "queued" ? t("canvas.nodes.state.cancel") : t("canvas.nodes.card.stop")}
        </Button>
      ) : (
        <InspectorRun
          label={runLabel}
          estimate={analysis?.estimate ?? null}
          models={byModel ? models.map((k) => ctx.model(k)) : [model]}
          disabled={readOnly}
          onRun={(anchor, bypassCache) => void run("node", { anchor, bypassCache })}
        />
      )}
    </>
  );
}

/**
 * Reads (design uODfj): the image coming in and where from, then the words from a Prompt node with
 * the chip that goes to it. Each Prompt node's part lights its link on hover, like on the card.
 */
function Reads({ nodeId }: { nodeId: string }) {
  const analysis = useNodeAnalysis(nodeId);
  const nodes = useCanvas((s) => s.doc.nodes);
  const store = useCanvasStoreApi();
  const links = (analysis?.imageLinks ?? []).filter((link) => link.port === "image");
  const images = links.flatMap((link) => link.images);
  const parts = analysis?.upstreamParts ?? [];
  const from = links[0] ? nodes[links[0].nodeId] : undefined;

  const focusPromptNode = () => {
    const state = store.getState();
    const source = incomingEdges(state.doc, nodeId, "prompt")[0]?.source;
    if (!source) return;
    state.actions.setSelection({ nodeIds: [source], edgeIds: [] });
    state.viewController.focusNode(source);
  };

  if (!images.length && !parts.length)
    return (
      <p className="w-full px-2 text-caption text-text-tertiary">
        {t("canvas.nodes.variations.readsNothing")}
      </p>
    );
  return (
    <div className="flex w-full flex-col gap-10 rounded-14 bg-surface p-12">
      {links[0] && images.length ? (
        <LinkedRow link={links[0]}>
          <span className="block size-32 shrink-0 overflow-hidden rounded-8 outline-1 -outline-offset-1 outline-border">
            {images[0] ? (
              <AssetImage assetId={images[0]} height={32} className="size-full" />
            ) : (
              <span className="block size-full bg-elevated-2" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-small font-medium text-text-primary">
              {t("canvas.nodes.variations.readsImages", { count: images.length })}
            </span>
            <span className="text-caption text-text-tertiary">
              {t(
                images.length > 1
                  ? "canvas.nodes.variations.readsFromEach"
                  : "canvas.nodes.variations.readsFrom",
                {
                  node: from ? nodeTitle(from, nodeRegistry) : "",
                },
              )}
            </span>
          </div>
        </LinkedRow>
      ) : null}
      {parts.length ? (
        <>
          <p className="w-full text-small leading-[1.5] break-words whitespace-pre-wrap text-text-primary">
            <LinkedPrompt parts={parts} own="" />
          </p>
          <MiniChip
            icon={Link}
            label={t("canvas.nodes.generate.fromPrompt")}
            onClick={focusPromptNode}
            className="self-start"
          />
        </>
      ) : null}
    </div>
  );
}

/** The image a Variations node reads: one block, lit with its link and source on hover. */
function LinkedRow({ link, children }: { link: LinkEnds; children: ReactNode }) {
  const hover = useLinkHover(link);
  return (
    <div {...hover} className="of-linked of-linked-block flex items-center gap-8">
      {children}
    </div>
  );
}

/** Prompts (design w1Enon): one field per prompt, the count, "Add a prompt" and what a prompt does. */
function PromptList({
  prompts,
  readOnly,
  onChange,
}: {
  prompts: readonly string[];
  readOnly: boolean;
  onChange: (prompts: string[]) => void;
}) {
  const fields = useRef<(HTMLInputElement | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  const rows = promptRows(prompts);
  const count = prompts.filter((line) => line.trim()).length;

  // A row made or removed by a key gets the focus once it's drawn.
  useEffect(() => {
    if (focus === null) return;
    const field = fields.current[focus];
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
    setFocus(null);
  }, [focus]);

  const apply = (change: { prompts: string[]; focus: number } | null) => {
    if (!change) return;
    if (change.prompts.length !== prompts.length || change.prompts.some((p, i) => p !== prompts[i]))
      onChange(change.prompts);
    setFocus(change.focus);
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply(enterRow(prompts, index));
    } else if (event.key === "Backspace" && event.currentTarget.value === "") {
      const change = backspaceRow(prompts, index);
      if (!change) return;
      event.preventDefault();
      apply(change);
    }
  };

  return (
    <div className="flex w-full flex-col gap-6 px-2">
      <div className="flex w-full items-center justify-between">
        <span className="text-caption text-text-tertiary">{t("canvas.nodes.variations.promptList")}</span>
        <span className="text-mono-12 text-text-tertiary">
          {t("canvas.nodes.variations.ofMax", { count, max: LIST_MAX })}
        </span>
      </div>
      {rows.map((row, index) => (
        // Inspector / Prompt row (design NCXEo), and / Empty for the one at the end (TUgzX).
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions in the list; a prompt's words can repeat.
          key={index}
          data-prompt-row={index}
          className="flex h-38 w-full items-center gap-8 rounded-10 bg-surface pr-4 pl-10 inset-ring inset-ring-border focus-within:inset-ring-border-strong"
        >
          <span className="shrink-0 text-mono-12 text-text-tertiary">{index + 1}</span>
          <input
            ref={(el) => {
              fields.current[index] = el;
            }}
            value={row.value}
            readOnly={readOnly}
            placeholder={t("canvas.nodes.variations.promptPlaceholder")}
            aria-label={t("canvas.nodes.variations.promptField", { index: index + 1 })}
            onChange={(event) => onChange(setRow(prompts, index, event.target.value))}
            onKeyDown={onKeyDown(index)}
            className="min-w-0 flex-1 bg-transparent text-small text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <button
            type="button"
            aria-label={t("canvas.nodes.variations.removePrompt", { index: index + 1 })}
            disabled={readOnly || row.next}
            onClick={() => apply(removeRow(prompts, index))}
            className="flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary not-disabled:hover:bg-elevated-2 not-disabled:hover:text-text-primary disabled:cursor-default disabled:text-text-tertiary"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="s"
        icon={Plus}
        disabled={readOnly || (prompts.length >= LIST_MAX && prompts[prompts.length - 1]?.trim() !== "")}
        className="self-start"
        onClick={() => apply(addRow(prompts))}
      >
        {t("canvas.nodes.variations.addPrompt")}
      </Button>
      <p className="w-full text-caption text-text-tertiary">{t("canvas.nodes.variations.promptsNote")}</p>
    </div>
  );
}

/** Models (design zgcYb): one row per model with its price, the count and "Add a model". */
function ModelList({
  ctx,
  params,
  readOnly,
  references,
  onChange,
}: {
  ctx: EngineContext;
  params: VariationsParams;
  readOnly: boolean;
  references: number;
  onChange: (models: ModelKey[]) => void;
}) {
  const models = modelList(params);
  return (
    <div className="flex w-full flex-col gap-6 px-2">
      <div className="flex w-full items-center justify-between">
        <span className="text-caption text-text-tertiary">{t("canvas.nodes.variations.modelList")}</span>
        <span className="text-mono-12 text-text-tertiary">
          {t("canvas.nodes.variations.ofMax", { count: models.length, max: LIST_MAX })}
        </span>
      </div>
      {models.map((modelKey) => (
        <ModelRow
          key={modelKey}
          ctx={ctx}
          params={params}
          modelKey={modelKey}
          inputImages={references}
          onRemove={readOnly ? undefined : () => onChange(models.filter((m) => m !== modelKey))}
        />
      ))}
      <AddModelPicker
        models={modelsFitting(ctx.models, { references })}
        exclude={models}
        disabled={readOnly || models.length >= LIST_MAX}
        onAdd={(m) => onChange([...models, m.key])}
      />
    </div>
  );
}

/**
 * Inspector / Model row (design Wbiov): the logo, the name, one take's price at its company's speed
 * with the image it reads, ×.
 */
function ModelRow({
  ctx,
  params,
  modelKey,
  inputImages,
  onRemove,
}: {
  ctx: EngineContext;
  params: VariationsParams;
  modelKey: ModelKey;
  /** Images each run reads: the incoming one, when an image is connected. */
  inputImages: number;
  onRemove?: () => void;
}) {
  const model = ctx.model(modelKey);
  const logo = logoFor(model?.providerId);
  const name = model?.displayName ?? modelKey;
  const run = model ? ctx.runSpeed?.(model) : undefined;
  const cost = model
    ? tightCost(estimateRun(model, carriedFor(model, params), "", run?.speed, { inputImages }, ctx.askPrice))
    : undefined;
  const price = cost && run?.fellBack ? `${cost} ${t("speed.suffix", { speed: run.name })}` : cost;
  return (
    <div
      data-model-row={modelKey}
      className="flex h-38 w-full items-center gap-8 rounded-10 bg-surface pr-4 pl-10 inset-ring inset-ring-border"
    >
      {logo ? <ProviderLogo provider={logo} /> : null}
      <span className="min-w-0 flex-1 truncate text-small text-text-primary">{name}</span>
      {price ? <span className="shrink-0 text-mono-12 text-text-tertiary">{price}</span> : null}
      <button
        type="button"
        aria-label={t("canvas.nodes.variations.removeModel", { model: name })}
        disabled={!onRemove}
        onClick={onRemove}
        className="flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary not-disabled:hover:bg-elevated-2 not-disabled:hover:text-text-primary disabled:cursor-default disabled:text-text-tertiary"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
