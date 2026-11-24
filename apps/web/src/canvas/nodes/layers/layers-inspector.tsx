import { nodeTitle } from "@openfield/canvas/engine/describe";
import {
  type LayersParams,
  layerSizeOf,
  layersModelKeyOf,
  layersSpec,
} from "@openfield/canvas/nodes/layers/spec";
import { incomingEdges } from "@openfield/canvas/store/graph";
import { LAYER_SIZES, LAYERS_PROMPT_MAX, type LayerSize, t } from "@openfield/core";
import { cn, Input, Segmented, SegmentedItem } from "@openfield/ui";
import { useId } from "react";
import { useNavigate } from "react-router";
import { useStore } from "zustand";
import { LayersModelPicker, PriceRow, pricingOf } from "../../../detail/layers/layers-panel";
import { layerModels } from "../../../detail/layers/stack";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas, useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { cardMedia } from "../generate/card-media";
import { nodeRegistry } from "../registry";
import { InspectorRun, LOCKED_DIM } from "../shell/inspector-parts";
import { AssetImage } from "../shell/thumb";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";

// Canvas / Inspector / Layers (design GCugSMFGGB): the image coming in, what to separate, the model
// (only models that split), the size, the price box the Layers tab has, then Run. The price box
// gives the rates and the most a split can cost: the model decides how many layers come back.

/** The canvas settings' field labels: 12/500, tertiary. */
const LABEL = "text-caption font-medium text-text-tertiary";

export function LayersInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const frame = useNodeFrame(nodeId);
  const params = useParsedParams<LayersParams>(nodeId, layersSpec, ctx);
  const setParams = useSetParams(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const navigate = useNavigate();
  const promptId = useId();
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const resting = readOnly || locked;
  const image = analysis?.baseImages?.[0] ?? null;
  const dims = useStore(cardMedia, (s) => (image ? s.dims[image] : undefined));
  const from = useCanvas((s) => {
    const source = incomingEdges(s.doc, nodeId, "image")[0]?.source;
    const node = source ? s.doc.nodes[source] : undefined;
    return node ? nodeTitle(node, nodeRegistry) : null;
  });
  const models = layerModels(ctx.models);
  const key = layersModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const rules = model?.capabilities.layers;
  const size = layerSizeOf(model, params.size);
  const pricing =
    model && image ? pricingOf(model, { id: image, width: dims?.w, height: dims?.h }, size) : null;
  const busy = display.state === "queued" || display.state === "running";

  if (!frame) return null;
  const subtitle = !from
    ? t("canvas.nodes.layers.noImage")
    : dims
      ? t("canvas.nodes.layers.from", { name: from, width: dims.w, height: dims.h })
      : t("canvas.nodes.layers.fromNode", { name: from });
  return (
    <>
      {/* Input card */}
      <div className={cn("flex w-full items-center gap-12 rounded-14 bg-surface p-12", locked && LOCKED_DIM)}>
        <span className="relative size-40 shrink-0 overflow-hidden rounded-8 bg-elevated-2">
          {image ? <AssetImage assetId={image} height={40} className="size-full" /> : null}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-8 inset-ring inset-ring-border"
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-small font-medium text-text-primary">{t("canvas.nodes.layers.image")}</span>
          <span className="truncate text-caption text-text-tertiary">{subtitle}</span>
        </div>
      </div>
      {/* What to separate */}
      <div className={cn("flex w-full flex-col gap-8 px-2 py-4", locked && LOCKED_DIM)}>
        <span className="flex w-full items-center justify-between">
          <label htmlFor={promptId} className={LABEL}>
            {t("canvas.nodes.layers.what")}
          </label>
          <span className="text-micro text-text-tertiary">{t("canvas.nodes.layers.optional")}</span>
        </span>
        <Input
          id={promptId}
          value={params.prompt}
          maxLength={LAYERS_PROMPT_MAX}
          readOnly={resting}
          placeholder={t("canvas.nodes.layers.whatPlaceholder")}
          onChange={(event) => setParams({ prompt: event.target.value }, "prompt")}
        />
      </div>
      {/* Model */}
      <div className={cn("flex w-full flex-col gap-6", locked && LOCKED_DIM)}>
        <div className="flex w-full flex-col gap-8 px-2 py-4">
          <span className={LABEL}>{t("canvas.nodes.inspector.model")}</span>
          <LayersModelPicker
            models={models}
            selected={model}
            onPick={(next) => {
              if (resting) return;
              // A model whose company has no key leads to where the key goes, as in the composer.
              if (!next.ready) navigate("/settings/api-keys", { state: { focusKey: true } });
              else if (next.key !== model?.key) setParams({ model: next.key });
            }}
          />
        </div>
      </div>
      {/* Size */}
      {rules ? (
        <div className={cn("flex w-full flex-col gap-8 px-2 py-4", locked && LOCKED_DIM)}>
          <span className={LABEL}>{t("layers.size.label")}</span>
          <Segmented
            value={size}
            aria-label={t("layers.size.label")}
            onValueChange={(next) => {
              if (!resting) setParams({ size: next as LayerSize });
            }}
          >
            {LAYER_SIZES.filter((s) => rules.sizes.includes(s)).map((s) => (
              <SegmentedItem key={s} value={s}>
                {s === "auto" ? t("layers.size.auto") : s}
              </SegmentedItem>
            ))}
          </Segmented>
        </div>
      ) : null}
      {/* Price */}
      {pricing ? (
        <div className={cn("flex w-full flex-col gap-8 rounded-14 bg-surface p-12", locked && LOCKED_DIM)}>
          <PriceRow label={t("layers.price.base")} value={pricing.rate} />
          <PriceRow label={t("layers.price.each")} value={pricing.rate} />
          <PriceRow label={t("layers.price.upTo", { count: pricing.most })} value={pricing.atMost} />
          <p className="w-full text-caption leading-[1.45] text-text-tertiary">{t("layers.price.note")}</p>
        </div>
      ) : null}
      <InspectorRun
        estimate={analysis?.estimate ?? null}
        models={[model]}
        disabled={readOnly || busy || !!analysis?.blocker}
        locked={locked}
        onRun={(anchor, bypassCache) => void run("node", { anchor, bypassCache })}
      />
    </>
  );
}
