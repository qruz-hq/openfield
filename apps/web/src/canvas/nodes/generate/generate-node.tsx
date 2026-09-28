import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { joinPrompt, modelKeyOf } from "@openfield/canvas/engine/inputs";
import type { NodeDisplay } from "@openfield/canvas/engine/types";
import { type CardLayout, cardLayout } from "@openfield/canvas/nodes/generate/card-size";
import { resolveFor } from "@openfield/canvas/nodes/generate/settings";
import { type GenerateParams, generateSpec } from "@openfield/canvas/nodes/generate/spec";
import { type AspectRatio, type ModelListItem, t } from "@openfield/core";
import { aspectLabel } from "@openfield/providers/manifest";
import { useStoreApi } from "@xyflow/react";
import { Image as ImageIcon } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useNodeParams, useNodeResult, useNodeRuntime } from "../../store/context";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { type CompanyWait, useCompanyWait } from "../shell/company-wait";
import { ImageCard } from "../shell/image-card";
import { LinkedPrompt } from "../shell/linked-text";
import { NodeShell } from "../shell/node-shell";
import { useNodeBasics, useNodeDisplay, useParsedParams } from "../shell/use-node";
import { CardImage, CardPager, CardPartial } from "./card";
import { cardMedia, showImage } from "./card-media";
import type { CardView } from "./card-state";
import { ReferenceStrip } from "./reference-strip";

// Canvas / Node / Generate (design Y5jjx): the card is the image, at the image's aspect ratio (the
// chosen one before there's an image). At rest: the image, the label and the ports, and a pill
// only when the state needs attention. On hover, keyboard focus, or as the only node selected:
// the top bar (pill, pager, menu) and the bottom bar (the start of the prompt and Run, or Stop /
// Cancel while it runs). Model, size, quality, aspect, count and prompt live in the inspector.

const NO_IMAGES: readonly string[] = [];

/** The card's box and which image it shows, following the image store as images load. */
function useCardLayout(
  id: string,
  frame: { id: string; size?: { w: number; h: number } },
): CardLayout & { images: readonly string[] } {
  const params = useNodeParams(id);
  const result = useNodeResult(id);
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const images = result?.assetIds ?? NO_IMAGES;
  const picked = useStore(cardMedia, (s) => s.shown[id]);
  const at = picked ? images.indexOf(picked) : -1;
  const assetId = images[at >= 0 ? at : 0];
  const dims = useStore(cardMedia, (s) => (assetId ? s.dims[assetId] : undefined));
  const layout = useMemo(
    () =>
      cardLayout({
        frame,
        params: params ?? {},
        result: { assetIds: images },
        ctx,
        media: {
          dims: assetId && dims ? { [assetId]: dims } : {},
          shown: picked ? { [id]: picked } : {},
        },
      }),
    [frame, params, images, ctx, assetId, dims, picked, id],
  );
  return { ...layout, images };
}

/**
 * Ports sit on the card's middle, so they move whenever its box does (an aspect ratio picked in
 * the settings, a new image). React Flow's own useUpdateNodeInternals waits a frame, which leaves
 * links pointing at the old ports for that frame; this asks its store to measure the node before
 * the frame is painted. `width` and `height` are the box React Flow's wrapper has in this render,
 * so the DOM is already resized. The first box is React Flow's to measure, like every node's.
 * While a fit to the nodes waits for them all to be measured, it waits a frame like React Flow's
 * hook: measuring one node early would fit the view to that node alone.
 */
function useSyncPorts(id: string, width: number | undefined, height: number | undefined) {
  const flow = useStoreApi();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!width || !height) return;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const measure = () => {
      const { domNode, updateNodeInternals } = flow.getState();
      const nodeElement = domNode?.querySelector<HTMLDivElement>(
        `.react-flow__node[data-id="${CSS.escape(id)}"]`,
      );
      if (nodeElement) updateNodeInternals(new Map([[id, { id, nodeElement, force: true }]]));
    };
    if (!flow.getState().fitViewQueued) return measure();
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [flow, id, width, height]);
}

export const GenerateNode = memo(function GenerateNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<GenerateParams>(id, generateSpec, ctx);
  const result = useNodeResult(id);
  const runtime = useNodeRuntime(id);
  const analysis = useNodeAnalysis(id);
  const display = useNodeDisplay(id);
  const frame = basics?.frame;
  // The box follows the image on show; the saved size follows it where it changes (engine/boxes.ts).
  const layout = useCardLayout(id, frame ?? { id });
  useSyncPorts(id, props.width, props.height);

  if (!frame) return null;
  const name = frame.title?.trim() || t(generateSpec.label);
  const images = result?.assetIds ?? [];
  const prompt = joinPrompt([analysis?.upstreamText, params.prompt]);
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const noRefs =
    model && !model.capabilities.references.supported ? t("canvas.nodes.ports.noReferences") : null;

  return (
    <NodeShell
      {...props}
      variant="card"
      spec={generateSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={display.state === "stale"}
      fanOut={display.fanOut}
      portOff={{ input_images: noRefs }}
      inspectable
      collapsedMeta={
        // The start of the prompt, cut at the second line (design lXVSR, CavmH).
        <span className="line-clamp-2 text-caption leading-[1.4] font-normal text-text-secondary">
          {prompt}
        </span>
      }
      collapsedStatus={<CollapsedStatus display={display} />}
      thumbs={images}
    >
      <GenerateCard
        id={id}
        name={name}
        selected={props.selected}
        display={display}
        layout={layout}
        prompt={prompt}
        params={params}
        partial={display.state === "running" ? (runtime?.partialThumbUrl ?? null) : null}
      />
    </NodeShell>
  );
});

interface GenerateCardProps {
  id: string;
  name: string;
  selected: boolean;
  display: NodeDisplay;
  layout: CardLayout & { images: readonly string[] };
  prompt: string;
  params: GenerateParams;
  partial: string | null;
}

/** The image card (nodes/shell/image-card.tsx) with Generate's image, pager, words and empty glyph. */
function GenerateCard({ id, name, selected, display, layout, prompt, params, partial }: GenerateCardProps) {
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const analysis = useNodeAnalysis(id);
  const wait = useCompanyWait(id);
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const several = layout.count > 1;
  const noPrompt = !prompt && (analysis?.references ?? 0) === 0;

  return (
    <ImageCard
      id={id}
      name={name}
      selected={selected}
      display={display}
      hasImages={layout.images.length > 0}
      partial={!!partial}
      box={layout}
      narrow={layout.narrow}
      short={layout.short}
      several={several}
      media={(opacity, view) =>
        partial ? (
          <CardPartial path={partial} opacity={opacity} />
        ) : layout.assetId && view.media !== "placeholder" ? (
          <CardImage assetId={layout.assetId} height={layout.h} contain={layout.contain} opacity={opacity} />
        ) : null
      }
      topExtra={
        several ? (
          <CardPager
            index={layout.index}
            count={layout.count}
            onPick={(index) => {
              const assetId = layout.images[index];
              if (assetId) showImage(id, assetId);
            }}
          />
        ) : null
      }
      empty={(view) => <EmptyGlyph view={view} params={params} model={model} wait={wait} />}
      text={(view) => (
        <>
          <ReferenceStrip images={analysis?.referenceImages ?? []} />
          <p className="of-card-prompt" data-placeholder={(noPrompt && view.phase === "empty") || undefined}>
            {prompt ? (
              <LinkedPrompt parts={analysis?.upstreamParts ?? []} own={params.prompt} />
            ) : view.phase === "empty" && noPrompt ? (
              t("canvas.nodes.card.noPrompt")
            ) : (
              ""
            )}
          </p>
        </>
      )}
      run={{
        estimate: analysis?.estimate ?? null,
        blocker: display.blocker,
        upToDate: analysis?.upToDate ?? false,
        seedless: !model?.capabilities.seed.supported,
        models: [model],
        muted: noPrompt,
      }}
      model={key}
    />
  );
}

/** Empty (Opg7S): the image glyph and the chosen ratio, or the company's wait in words. */
function EmptyGlyph({
  view,
  params,
  model,
  wait,
}: {
  view: CardView;
  params: GenerateParams;
  model: ModelListItem | undefined;
  wait: CompanyWait | null;
}) {
  const own: AspectRatio | undefined =
    params.size?.kind === "aspect" ? params.size.ratio : params.size?.kind === "auto" ? "auto" : undefined;
  const aspect = model ? resolveFor(model, params, 1).aspect : own;
  const words = view.phase === "atCompany";
  const note = words
    ? wait?.speed !== "batch"
      ? t("speed.tile.fewMinutes")
      : wait.stopping || wait.state === "submitting"
        ? null
        : t("speed.tile.fewHours")
    : aspect
      ? aspectLabel(aspect)
      : null;
  return (
    <div className="flex flex-col items-center gap-8">
      {/* Over the voxels only a wait note stays; the swarm takes the glyph's place. */}
      {view.voxels ? null : <ImageIcon size={24} aria-hidden className="text-text-tertiary" />}
      {note ? (
        <span
          className={
            words || aspect === "auto" ? "text-caption text-text-tertiary" : "text-mono-12 text-text-tertiary"
          }
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}
