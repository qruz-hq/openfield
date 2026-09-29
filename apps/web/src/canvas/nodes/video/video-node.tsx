import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { joinPrompt } from "@openfield/canvas/engine/inputs";
import type { NodeDisplay } from "@openfield/canvas/engine/types";
import { type CardLayout, cardLayout } from "@openfield/canvas/nodes/generate/card-size";
import { type VideoParams, videoModelKeyOf, videoSpec } from "@openfield/canvas/nodes/video/spec";
import { type AspectRatio, type ModelListItem, t } from "@openfield/core";
import { useStoreApi } from "@xyflow/react";
import { Film } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useNodeParams, useNodeResult, useNodeRuntime } from "../../store/context";
import { CardImage, CardPager, CardPartial } from "../generate/card";
import { cardMedia, showImage } from "../generate/card-media";
import type { CardView } from "../generate/card-state";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { type CompanyWait, useCompanyWait } from "../shell/company-wait";
import { ImageCard } from "../shell/image-card";
import { LinkedPrompt } from "../shell/linked-text";
import { NodeShell } from "../shell/node-shell";
import { useNodeBasics, useNodeDisplay, useParsedParams } from "../shell/use-node";
import { DurationPill, useAssetDuration } from "./duration";

// Canvas / Node / Video (design mYnmv): the card is the video's first frame, at the video's aspect
// ratio (the chosen one before there's a result) — the same shell as Generate's (Y5jjx), with a
// duration pill on the media and Film as its empty glyph and port icon.

const NO_IMAGES: readonly string[] = [];

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

/** See generate-node.tsx's useSyncPorts: keeps the port handles on the card's edge as its box moves. */
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

export const VideoNode = memo(function VideoNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<VideoParams>(id, videoSpec, ctx);
  const result = useNodeResult(id);
  const runtime = useNodeRuntime(id);
  const analysis = useNodeAnalysis(id);
  const display = useNodeDisplay(id);
  const frame = basics?.frame;
  const layout = useCardLayout(id, frame ?? { id });
  useSyncPorts(id, props.width, props.height);

  if (!frame) return null;
  const name = frame.title?.trim() || t(videoSpec.label);
  const prompt = joinPrompt([analysis?.upstreamText, params.prompt]);
  const key = videoModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const endUnsupported =
    model && !model.capabilities.video?.frames.end
      ? t("video.chips.endFrame.unsupported", { model: model.displayName })
      : null;

  return (
    <NodeShell
      {...props}
      variant="card"
      spec={videoSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={display.state === "stale"}
      fanOut={display.fanOut}
      portOff={{ end_frame: endUnsupported }}
      inspectable
      collapsedMeta={
        <span className="line-clamp-2 text-caption leading-[1.4] font-normal text-text-secondary">
          {prompt}
        </span>
      }
      collapsedStatus={<CollapsedStatus display={display} />}
      thumbs={result?.assetIds ?? []}
    >
      <VideoCard
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

interface VideoCardProps {
  id: string;
  name: string;
  selected: boolean;
  display: NodeDisplay;
  layout: CardLayout & { images: readonly string[] };
  prompt: string;
  params: VideoParams;
  partial: string | null;
}

/** The video card (nodes/shell/image-card.tsx) with the poster, pager, duration pill and Film glyph. */
function VideoCard({ id, name, selected, display, layout, prompt, params, partial }: VideoCardProps) {
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const analysis = useNodeAnalysis(id);
  const wait = useCompanyWait(id);
  const key = videoModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const several = layout.count > 1;
  const noPrompt = !prompt.trim();
  const duration = useAssetDuration(layout.assetId);

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
          <>
            <CardImage
              assetId={layout.assetId}
              height={layout.h}
              contain={layout.contain}
              opacity={opacity}
            />
            {duration !== null ? <DurationPill seconds={duration} /> : null}
          </>
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
      text={() => (
        <p className="of-card-prompt" data-placeholder={noPrompt || undefined}>
          {prompt ? (
            <LinkedPrompt parts={analysis?.upstreamParts ?? []} own={params.prompt} />
          ) : noPrompt ? (
            t("canvas.nodes.video.promptPlaceholder")
          ) : (
            ""
          )}
        </p>
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

function EmptyGlyph({
  view,
  params,
  wait,
}: {
  view: CardView;
  params: VideoParams;
  model: ModelListItem | undefined;
  wait: CompanyWait | null;
}) {
  const own: AspectRatio | undefined =
    params.size?.kind === "aspect" ? params.size.ratio : params.size?.kind === "auto" ? "auto" : undefined;
  const words = view.phase === "atCompany";
  const note = words
    ? wait?.speed !== "batch"
      ? t("speed.tile.fewMinutes")
      : wait.stopping || wait.state === "submitting"
        ? null
        : t("speed.tile.fewHours")
    : own === "auto"
      ? t("composer.chips.aspect.auto")
      : (own ?? null);
  return (
    <div className="flex flex-col items-center gap-8">
      {view.voxels ? null : <Film size={24} aria-hidden className="text-text-tertiary" />}
      {note ? (
        <span
          className={
            words || own === "auto" ? "text-caption text-text-tertiary" : "text-mono-12 text-text-tertiary"
          }
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}
