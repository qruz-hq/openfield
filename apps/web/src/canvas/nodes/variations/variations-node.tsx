import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { modelName } from "@openfield/canvas/engine/describe";
import { modelKeyOf } from "@openfield/canvas/engine/inputs";
import type { EngineContext, NodeDisplay } from "@openfield/canvas/engine/types";
import { CARD_SHORT_BELOW } from "@openfield/canvas/nodes/generate/card-size";
import { takesOf, variationsLayout } from "@openfield/canvas/nodes/variations/card-size";
import {
  modelList,
  promptLines,
  VARIATIONS_PORTS,
  type VariationsParams,
  variationsSpec,
} from "@openfield/canvas/nodes/variations/spec";
import { t } from "@openfield/core";
import { BrandMark, ModelCaption } from "@openfield/ui";
import { memo, useMemo } from "react";
import { useStore } from "zustand";
import { logoFor } from "../../../lib/provider";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useNodeParams, useNodeResult } from "../../store/context";
import { cardMedia } from "../generate/card-media";
import type { CardView } from "../generate/card-state";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { type CompanyWait, useCompanyWait } from "../shell/company-wait";
import { ImageCard } from "../shell/image-card";
import { LinkedPrompt } from "../shell/linked-text";
import { NodeShell } from "../shell/node-shell";
import { ResultGrid, sourceLabel } from "../shell/results";
import { useNodeBasics, useNodeDisplay, useParsedParams } from "../shell/use-node";

// Canvas / Node / Variations (design njYDO, hover T1RODM): like Generate, the card is its images,
// every take in the results grid, each labelled by its prompt line (Prompts) or model (Models) and,
// for an incoming image list, by the image it came from. At rest: the images, the label and the
// ports; on hover or selected, the image card's bars: the state and menu on top, what it makes, the
// words it runs and Run with its price at the bottom. What it makes and how (New takes, Prompts,
// Models, the size) lives in its side sheet (variations-inspector.tsx).

const NO_IMAGES: readonly string[] = [];

/** "4 new takes · Nano Banana 2", "3 prompts · Nano Banana 2", "3 models" (design q5kM8). */
export function summaryOf(params: VariationsParams, ctx: EngineContext): string {
  if (params.strategy === "model-list")
    return t("canvas.nodes.variations.summary.models", { count: modelList(params).length });
  const what =
    params.strategy === "prompt-list"
      ? t("canvas.nodes.variations.summary.prompts", { count: promptLines(params).length })
      : t("canvas.nodes.variations.summary.takes", { count: params.count });
  const key = modelKeyOf(params.model, ctx);
  return key ? `${what} · ${modelName(ctx, key)}` : what;
}

export const VariationsNode = memo(function VariationsNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<VariationsParams>(id, variationsSpec, ctx);
  const result = useNodeResult(id);
  const display = useNodeDisplay(id);
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);

  if (!basics) return null;
  const { frame } = basics;
  const byModel = params.strategy === "model-list";
  const images = result?.assetIds ?? NO_IMAGES;
  const name = frame.title?.trim() || t(variationsSpec.label);

  return (
    <NodeShell
      {...props}
      variant="card"
      spec={variationsSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={display.state === "stale"}
      fanOut={display.fanOut}
      inspectable
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
    >
      <VariationsCard
        id={id}
        name={name}
        selected={props.selected}
        display={display}
        frame={frame}
        params={params}
        images={images}
      />
    </NodeShell>
  );
});

interface VariationsCardProps {
  id: string;
  name: string;
  selected: boolean;
  display: NodeDisplay;
  frame: { id: string; size?: { w: number; h: number } };
  params: VariationsParams;
  images: readonly string[];
}

/** The image card (nodes/shell/image-card.tsx) with Variations' grid, summary, words and mark. */
function VariationsCard({ id, name, selected, display, frame, params, images }: VariationsCardProps) {
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const analysis = useNodeAnalysis(id);
  const result = useNodeResult(id);
  const wait = useCompanyWait(id);
  const rawParams = useNodeParams(id);
  const first = images[0];
  const dims = useStore(cardMedia, (s) => (first ? s.dims[first] : undefined));
  // The box follows the first image's shape, the chosen ratio before there's one (card-size.ts).
  const box = useMemo(
    () =>
      variationsLayout({
        frame,
        params: rawParams ?? {},
        result: { assetIds: images },
        ctx,
        media: { dims: first && dims ? { [first]: dims } : {}, shown: {} },
      }),
    [frame, rawParams, images, ctx, first, dims],
  );
  const outputs = result?.outputs ?? [];
  const lines = promptLines(params);
  const byModel = params.strategy === "model-list";
  const key = modelKeyOf(params.model, ctx);
  const models = byModel ? modelList(params).map((k) => ctx.model(k)) : [ctx.model(key)];
  const parts = analysis?.upstreamParts ?? [];
  // It runs from a prompt coming in or an incoming image; Prompts mode also from its own lines.
  const nothingIn =
    !parts.length &&
    (analysis?.references ?? 0) === 0 &&
    (params.strategy !== "prompt-list" || !lines.length);
  const nothingToMake = takesOf(params) === 0;

  // Captions: by fanned-out image when a list came in, else by prompt line (Prompts) or model (Models).
  const labelOf = (index: number): string | null => {
    const output = outputs[index];
    if (!output) return null;
    if (display.fanOut > 1 && output.source !== undefined) return sourceLabel(output.source);
    if (params.strategy === "prompt-list" && output.call !== undefined) return lines[output.call] ?? null;
    if (byModel && output.model) return modelName(ctx, output.model);
    return null;
  };

  return (
    <ImageCard
      id={id}
      name={name}
      selected={selected}
      display={display}
      hasImages={images.length > 0}
      box={box}
      short={box.h < CARD_SHORT_BELOW}
      rail={{ ports: VARIATIONS_PORTS, middle: box.h / 2 }}
      media={(opacity, view) =>
        images.length && view.media !== "placeholder" ? (
          <ResultGrid
            assetIds={images}
            labelOf={labelOf}
            height={box.h}
            opacity={opacity}
            className="absolute inset-0"
          />
        ) : null
      }
      empty={(view) => <EmptyMark view={view} wait={wait} />}
      text={(view) => (
        <div className="flex w-full flex-col gap-4">
          <p className="of-card-summary">{summaryOf(params, ctx)}</p>
          <p className="of-card-prompt" data-placeholder={(nothingIn && view.phase === "empty") || undefined}>
            {parts.length ? (
              <LinkedPrompt parts={parts} own="" separator=" " />
            ) : view.phase === "empty" && nothingIn ? (
              t("canvas.nodes.card.noPrompt")
            ) : (
              ""
            )}
          </p>
        </div>
      )}
      run={{
        estimate: analysis?.estimate ?? null,
        blocker: display.blocker,
        upToDate: analysis?.upToDate ?? false,
        seedless: !models.some((m) => m?.capabilities.seed.supported),
        models,
        muted: nothingIn || nothingToMake,
      }}
      model={byModel ? (modelList(params)[0] ?? null) : key}
    />
  );
}

/** An empty card: the mark (the swarm takes its place while it runs), or the company's wait in words. */
function EmptyMark({ view, wait }: { view: CardView; wait: CompanyWait | null }) {
  const note =
    view.phase === "atCompany"
      ? wait?.speed !== "batch"
        ? t("speed.tile.fewMinutes")
        : wait.stopping || wait.state === "submitting"
          ? null
          : t("speed.tile.fewHours")
      : null;
  return (
    <div className="flex flex-col items-center gap-8">
      {view.voxels ? null : <BrandMark size={24} className="opacity-30" />}
      {note ? <span className="text-caption text-text-tertiary">{note}</span> : null}
    </div>
  );
}
