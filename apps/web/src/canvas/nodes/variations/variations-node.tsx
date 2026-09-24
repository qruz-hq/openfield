import { type ModelKey, t } from "@openfield/core";
import { BrandMark, ModelCaption, ProviderLogo, Segmented, SegmentedItem, StepperChip } from "@openfield/ui";
import { X } from "lucide-react";
import { memo, useMemo } from "react";
import { estimateRun } from "../../../lib/controls";
import { tightCost } from "../../../lib/cost";
import { logoFor } from "../../../lib/provider";
import { EMPTY_ENGINE_CONTEXT } from "../../engine/context-base";
import { modelName } from "../../engine/describe";
import { useNodeAnalysis } from "../../engine/engine-store";
import { modelKeyOf, modelsFitting } from "../../engine/inputs";
import type { EngineContext } from "../../engine/types";
import { useNodeResult, useReadOnly } from "../../store/context";
import { carriedFor } from "../generate/settings";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { NodeShell } from "../shell/node-shell";
import { ResultGrid, sourceLabel } from "../shell/results";
import { RunPill } from "../shell/run-pill";
import { StateBand } from "../shell/state-band";
import { useNodeBasics, useNodeDisplay, useParsedParams, useSetParams } from "../shell/use-node";
import { AddModelPicker } from "./add-model";
import {
  LIST_MAX,
  modelList,
  promptLines,
  TAKES_MAX,
  TAKES_MIN,
  type VariationStrategy,
  type VariationsParams,
  variationsSpec,
} from "./spec";

// Canvas / Node / Variations (design zodbS; Models mode mdu6t): results over the strategy switch
// (New takes · Prompts · Models) and that strategy's own control, then the run pill. An incoming
// image list runs the whole set once per image, labelled "Image 1…k" (M4-17).

const RESULTS_HEIGHT = 250;
const MODEL_IMAGE_HEIGHT = 280;

const STRATEGIES: { value: VariationStrategy; label: "newTakes" | "promptList" | "modelList" }[] = [
  { value: "same-prompt", label: "newTakes" },
  { value: "prompt-list", label: "promptList" },
  { value: "model-list", label: "modelList" },
];

function ModelTag({
  ctx,
  modelKey,
  onRemove,
}: {
  ctx: EngineContext;
  modelKey: ModelKey;
  onRemove?: () => void;
}) {
  const model = ctx.model(modelKey);
  const logo = logoFor(model?.providerId);
  const name = modelName(ctx, modelKey);
  return (
    <span className="inline-flex shrink-0 items-center gap-6 rounded-8 bg-elevated-2 px-9 py-5 inset-ring inset-ring-border">
      {logo ? <ProviderLogo provider={logo} /> : null}
      <span className="text-caption text-text-primary">{name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={t("canvas.nodes.variations.removeModel", { model: name })}
          onClick={onRemove}
          className="nodrag -m-3 inline-flex cursor-pointer rounded-4 p-3 text-text-tertiary hover:text-text-secondary"
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

export const VariationsNode = memo(function VariationsNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<VariationsParams>(id, variationsSpec, ctx);
  const setParams = useSetParams(id);
  const result = useNodeResult(id);
  const analysis = useNodeAnalysis(id);
  const display = useNodeDisplay(id);
  const readOnly = useReadOnly();
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const models = useMemo(() => modelList(params), [params]);

  if (!basics) return null;
  const { frame } = basics;
  const name = frame.title?.trim() || t(variationsSpec.label);
  const strategy = params.strategy;
  const byModel = strategy === "model-list";
  const images = result?.assetIds ?? [];
  const outputs = result?.outputs ?? [];
  const stale = display.state === "stale";
  const lines = promptLines(params);

  // Captions: by fanned-out image when a list came in, else by prompt line in Prompts mode.
  const labelOf = (index: number): string | null => {
    const output = outputs[index];
    if (!output) return null;
    if (display.fanOut > 1 && output.source !== undefined) return sourceLabel(output.source);
    if (strategy === "prompt-list" && output.call !== undefined) return lines[output.call] ?? null;
    return null;
  };

  const pickStrategy = (value: string) => {
    const next = value as VariationStrategy;
    if (next === strategy) return;
    // Models mode starts from the model the node already uses.
    const patch: Record<string, unknown> = { strategy: next };
    if (next === "model-list" && !models.length && key) patch.models = [key];
    setParams(patch);
  };

  const band = (
    <div className="absolute inset-x-0 bottom-0 flex flex-col justify-end">
      <StateBand id={id} display={display} model={key} />
    </div>
  );
  const empty = (
    <div className="absolute inset-0 flex items-center justify-center bg-surface">
      <BrandMark size={24} className="opacity-30" />
    </div>
  );

  const results = byModel ? (
    <div className="relative flex w-full gap-2">
      {(models.length ? models : [key ?? ""]).map((modelKey) => {
        const own = images.filter((_, i) => outputs[i]?.model === modelKey);
        const m = ctx.model(modelKey);
        const logo = logoFor(m?.providerId);
        const price = m ? tightCost(estimateRun(m, carriedFor(m, params), "")) : undefined;
        return (
          <div key={modelKey} className="flex min-w-0 flex-1 flex-col">
            <div className="relative w-full" style={{ height: MODEL_IMAGE_HEIGHT }}>
              {own.length ? (
                <ResultGrid
                  assetIds={own}
                  height={MODEL_IMAGE_HEIGHT}
                  dim={stale}
                  className="absolute inset-0"
                />
              ) : (
                empty
              )}
            </div>
            <div className="flex w-full px-12 py-10">
              {logo ? (
                <ModelCaption
                  provider={logo}
                  name={modelName(ctx, modelKey)}
                  cost={price}
                  className="min-w-0"
                />
              ) : (
                <span className="truncate text-micro font-medium text-text-primary">
                  {modelName(ctx, modelKey)}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {band}
    </div>
  ) : (
    <div className="relative w-full" style={{ height: RESULTS_HEIGHT }}>
      {images.length ? (
        <ResultGrid
          assetIds={images}
          labelOf={labelOf}
          height={RESULTS_HEIGHT}
          dim={stale}
          className="absolute inset-0"
        />
      ) : (
        empty
      )}
      {band}
    </div>
  );

  const pill = (
    <RunPill
      id={id}
      name={name}
      estimate={analysis?.estimate ?? null}
      blocker={display.blocker}
      upToDate={analysis?.upToDate ?? false}
      seedless={!model?.capabilities.seed.supported}
    />
  );

  return (
    <NodeShell
      {...props}
      spec={variationsSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={stale}
      fanOut={display.fanOut}
      inspectable
      contentSized
      collapsedMeta={
        model && logoFor(model.providerId) ? (
          <ModelCaption
            provider={logoFor(model.providerId)!}
            name={byModel ? t("canvas.nodes.variations.modelList") : model.displayName}
          />
        ) : (
          <span className="truncate text-micro font-medium text-text-primary">{name}</span>
        )
      }
      collapsedStatus={<CollapsedStatus display={display} />}
      thumbs={images}
      frameClassName={byModel ? "w-634 min-h-[430px]" : "w-320 min-h-360"}
    >
      {results}
      <div className="flex shrink-0 flex-col gap-10 p-12">
        <Segmented
          value={strategy}
          onValueChange={pickStrategy}
          disabled={readOnly}
          aria-label={t("canvas.nodes.variations.strategy")}
          className="nodrag"
        >
          {STRATEGIES.map((s) => (
            <SegmentedItem key={s.value} value={s.value}>
              {t(`canvas.nodes.variations.${s.label}`)}
            </SegmentedItem>
          ))}
        </Segmented>
        {strategy === "same-prompt" ? (
          <div className="flex w-full items-center justify-between">
            <StepperChip
              value={params.count}
              min={TAKES_MIN}
              max={TAKES_MAX}
              disabled={readOnly}
              onValueChange={(count) => setParams({ count }, "count")}
              label={t("canvas.nodes.variations.takes")}
              decrementLabel={t("canvas.nodes.variations.fewer")}
              incrementLabel={t("canvas.nodes.variations.more")}
              className="nodrag"
            />
            {pill}
          </div>
        ) : strategy === "prompt-list" ? (
          <>
            <div className="flex h-96 flex-col rounded-14 bg-surface p-12">
              <textarea
                value={params.prompts.join("\n")}
                readOnly={readOnly}
                placeholder={t("canvas.nodes.variations.promptsPlaceholder")}
                aria-label={t("canvas.nodes.variations.promptsField")}
                onChange={(event) => setParams({ prompts: event.target.value.split("\n") }, "prompts")}
                onKeyDown={(event) => event.stopPropagation()}
                className="nodrag nowheel min-h-0 w-full flex-1 resize-none bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </div>
            <div className="flex w-full items-center justify-between">
              <span className="text-caption text-text-tertiary">
                {t("canvas.nodes.variations.promptsCount", { count: lines.length })}
              </span>
              {pill}
            </div>
          </>
        ) : (
          <div className="flex w-full flex-col gap-10">
            {models.length ? (
              <div className="flex w-full flex-wrap items-center gap-6">
                {models.map((modelKey) => (
                  <ModelTag
                    key={modelKey}
                    ctx={ctx}
                    modelKey={modelKey}
                    onRemove={
                      readOnly ? undefined : () => setParams({ models: models.filter((m) => m !== modelKey) })
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="flex w-full items-center justify-between">
              <AddModelPicker
                models={modelsFitting(ctx.models, { references: analysis?.references ?? 0 })}
                exclude={models}
                disabled={readOnly || models.length >= LIST_MAX}
                onAdd={(m) => setParams({ models: [...models, m.key] })}
              />
              {pill}
            </div>
          </div>
        )}
      </div>
    </NodeShell>
  );
});
