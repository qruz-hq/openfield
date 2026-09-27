import { type AspectRatio, type ModelListItem, t } from "@openfield/core";
import { aspectLabel } from "@openfield/providers/manifest";
import { Button, IconButton, ProgressBar } from "@openfield/ui";
import { useStoreApi } from "@xyflow/react";
import {
  Check,
  CircleAlert,
  CircleStop,
  Clock3,
  Ellipsis,
  Hourglass,
  Image as ImageIcon,
  Info,
  KeyRound,
  Loader,
  type LucideIcon,
  Pencil,
  Play,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { useProviders } from "../../../api/hooks/keys";
import { companyName } from "../../../lib/provider";
import { EMPTY_ENGINE_CONTEXT } from "../../engine/context-base";
import { useNodeAnalysis } from "../../engine/engine-store";
import { joinPrompt, modelKeyOf } from "../../engine/inputs";
import type { NodeBlocker, NodeDisplay } from "../../engine/types";
import { useCanvas, useNodeParams, useNodeResult, useNodeRuntime, useReadOnly } from "../../store/context";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { type CompanyWait, useCompanyWait } from "../shell/company-wait";
import { focusNodeSoon } from "../shell/focus";
import { NodeShell, useCardMenu } from "../shell/node-shell";
import { RunPill } from "../shell/run-pill";
import {
  clock,
  useBlockedMessage,
  useBlockerFix,
  useCancel,
  useElapsed,
  useFailureFix,
} from "../shell/state-band";
import { useNodeBasics, useNodeDisplay, useParsedParams, useRunNode } from "../shell/use-node";
import { CardImage, CardMessage, CardPager, CardPartial, CardPill, type CardPillProps } from "./card";
import { cardMedia, showImage } from "./card-media";
import { type CardLayout, cardLayout } from "./card-size";
import { type CardView, cardView, hasScrim } from "./card-state";
import { resolveFor } from "./settings";
import { type GenerateParams, generateSpec } from "./spec";

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

/** Media (g0PW4) and its layers, in paint order: image, Stripes, Top, Bottom, Center, Progress. */
function GenerateCard({ id, name, selected, display, layout, prompt, params, partial }: GenerateCardProps) {
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const analysis = useNodeAnalysis(id);
  const menu = useCardMenu();
  const readOnly = useReadOnly();
  const wait = useCompanyWait(id);
  // Selected on its own, the card keeps its bars (and while its menu is open); in a
  // multi-selection only the outline shows.
  const solo = useCanvas((s) => s.selection.nodeIds.length === 1);
  const bars = (selected && solo) || !!menu?.isOpen;
  const view = cardView({
    state: display.state,
    images: layout.images.length > 0,
    atCompany: !!wait,
    partial: !!partial,
  });
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const several = layout.count > 1;
  const scrim = hasScrim(view);
  // Over an image the bars and what's on them are dark in both themes (nodes.css).
  const paint = scrim ? "dark" : undefined;
  const noPrompt = !prompt && (analysis?.references ?? 0) === 0;
  const opacity = view.media === "dimmed" ? 0.5 : view.media === "faded" ? 0.6 : 1;

  return (
    <div
      className="of-card"
      data-media={view.media === "placeholder" ? "placeholder" : "image"}
      data-tone={view.phase === "failed" ? "danger" : undefined}
      data-scrim={scrim || undefined}
      data-bars={bars || undefined}
      data-narrow={layout.narrow || undefined}
      data-several={several || undefined}
      data-short={layout.short || undefined}
      data-message={view.message || undefined}
      data-phase={view.phase}
    >
      {partial ? (
        <CardPartial path={partial} opacity={opacity} />
      ) : layout.assetId && view.media !== "placeholder" ? (
        <CardImage assetId={layout.assetId} height={layout.h} contain={layout.contain} opacity={opacity} />
      ) : null}
      {view.stripes ? <div aria-hidden className="of-card-stripes of-blocked-stripes" /> : null}
      <div className="of-card-top" data-paint={paint}>
        {view.noPill ? null : <StatusPill id={id} view={view} display={display} />}
        {several ? (
          <CardPager
            index={layout.index}
            count={layout.count}
            onPick={(index) => {
              const assetId = layout.images[index];
              if (assetId) showImage(id, assetId);
            }}
          />
        ) : null}
        <span className="h-1 flex-1" />
        {readOnly ? null : (
          <IconButton
            variant="overlay"
            size={32}
            icon={Ellipsis}
            label={t("canvas.nodes.menu.label")}
            className="of-card-menu of-reveal nodrag"
            onClick={(event) => {
              event.stopPropagation();
              menu?.open(event.currentTarget);
            }}
          />
        )}
      </div>
      <div className={view.bottomAtRest ? "of-card-bottom" : "of-card-bottom of-reveal"} data-paint={paint}>
        <p className="of-card-prompt" data-placeholder={(noPrompt && view.phase === "empty") || undefined}>
          {prompt || (view.phase === "empty" && noPrompt ? t("canvas.nodes.card.noPrompt") : "")}
        </p>
        {view.action === "run" ? (
          <RunPill
            id={id}
            name={name}
            estimate={analysis?.estimate ?? null}
            blocker={display.blocker}
            upToDate={analysis?.upToDate ?? false}
            seedless={!model?.capabilities.seed.supported}
            models={[model]}
            muted={noPrompt}
            primary
          />
        ) : view.action ? (
          <StopButton id={id} name={name} cancel={view.action === "cancel"} />
        ) : null}
      </div>
      <div className="of-card-center" data-over-image={(view.message && scrim) || undefined}>
        {view.emptyGlyph ? <EmptyGlyph view={view} params={params} model={model} wait={wait} /> : null}
        {view.message ? (
          <Message id={id} view={view} display={display} model={key} overImage={scrim} />
        ) : null}
      </div>
      {view.progress ? <Progress id={id} /> : null}
    </div>
  );
}

function StatusPill({ id, view, display }: { id: string; view: CardView; display: NodeDisplay }) {
  const runtime = useNodeRuntime(id);
  const wait = useCompanyWait(id);
  const providers = useProviders().data;
  const elapsed = useElapsed(runtime?.startedAt ?? null, view.phase === "generating");
  const common = { reveal: !view.pillAtRest, long: view.longPill };
  const pill = ((): CardPillProps => {
    switch (view.phase) {
      case "waiting":
        return {
          icon: Clock3,
          label: t("canvas.nodes.state.waiting"),
          detail: runtime?.position ? t("canvas.nodes.state.position", { position: runtime.position }) : null,
        };
      case "atCompany": {
        // "Waiting at Google" + "Batch", or "Waiting for Google" + "Flex" (design QZNse).
        const company = companyName(providers, wait?.providerId ?? "");
        if (wait?.speed !== "batch")
          return {
            icon: Hourglass,
            label: t("speed.tile.waitingFor", { company }),
            detail: t("speed.names.flex"),
          };
        if (wait.stopping) return { icon: Hourglass, label: t("speed.tile.stopping", { company }) };
        if (wait.state === "submitting")
          return { icon: Hourglass, label: t("speed.tile.sending", { company }) };
        return {
          icon: Hourglass,
          label: t("speed.tile.waiting", { company }),
          detail: t("speed.names.batch"),
        };
      }
      case "generating":
        return { icon: Loader, spin: true, label: t("canvas.nodes.state.generating"), value: clock(elapsed) };
      case "changed":
        return {
          dot: true,
          label:
            display.chip === "older_settings"
              ? t("canvas.nodes.state.olderSettings")
              : t("canvas.nodes.state.inputsChanged"),
        };
      case "failed":
        return { icon: CircleAlert, tone: "danger", label: t("canvas.nodes.card.failed") };
      case "blocked":
        // "Needs a key" only when the key is missing; a company turned off in Settings has one.
        return display.blocker?.kind === "no_key"
          ? { icon: KeyRound, label: t("canvas.nodes.card.needsKey") }
          : { icon: Info, label: t("canvas.nodes.card.cantRun") };
      case "canceled":
        return { icon: CircleStop, label: t("canvas.nodes.card.canceled") };
      default:
        return { icon: Check, label: t("canvas.nodes.state.upToDate") };
    }
  })();
  return <CardPill {...pill} {...common} />;
}

/** Stop for a run under way, Cancel for one waiting (design GnRxu). Named for its node, like Run. */
function StopButton({ id, name, cancel }: { id: string; name: string; cancel: boolean }) {
  const stop = useCancel(id);
  return (
    <Button
      variant="overlay"
      size="s"
      icon={cancel ? X : Square}
      aria-label={
        cancel ? t("canvas.nodes.card.cancelNamed", { name }) : t("canvas.nodes.card.stopNamed", { name })
      }
      data-node-primary
      className="nodrag"
      onClick={(event) => {
        event.stopPropagation();
        stop();
      }}
    >
      {cancel ? t("canvas.nodes.state.cancel") : t("canvas.nodes.card.stop")}
    </Button>
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
      <ImageIcon size={24} aria-hidden className="text-text-tertiary" />
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

function Message({
  id,
  view,
  display,
  model,
  overImage,
}: {
  id: string;
  view: CardView;
  display: NodeDisplay;
  model: string | null;
  overImage: boolean;
}) {
  if (view.phase === "failed") return <FailedMessage id={id} model={model} overImage={overImage} />;
  if (view.phase === "blocked" && display.blocker)
    return <BlockedMessage id={id} blocker={display.blocker} overImage={overImage} />;
  if (view.phase === "canceled") return <CanceledMessage id={id} overImage={overImage} />;
  return null;
}

const FIX_ICON: Record<string, LucideIcon | undefined> = { try_again: RefreshCw, edit_prompt: Pencil };

function FailedMessage({ id, model, overImage }: { id: string; model: string | null; overImage: boolean }) {
  const { message, action } = useFailureFix(id, model);
  return (
    <CardMessage text={message} overImage={overImage}>
      <Button
        variant="ghost-accent"
        size="s"
        icon={FIX_ICON[action.kind]}
        data-node-primary
        className="nodrag"
        onClick={(event) => {
          event.stopPropagation();
          action.run();
        }}
      >
        {action.label}
      </Button>
    </CardMessage>
  );
}

function BlockedMessage({
  id,
  blocker,
  overImage,
}: {
  id: string;
  blocker: NodeBlocker;
  overImage: boolean;
}) {
  const { copy, onFix } = useBlockerFix(id, blocker);
  const text = useBlockedMessage(blocker);
  return (
    <CardMessage text={text} overImage={overImage}>
      {copy.action ? (
        <Button
          variant="secondary"
          size="s"
          data-node-primary
          className="nodrag"
          onClick={(event) => {
            event.stopPropagation();
            onFix();
          }}
        >
          {copy.action}
        </Button>
      ) : null}
    </CardMessage>
  );
}

function CanceledMessage({ id, overImage }: { id: string; overImage: boolean }) {
  const run = useRunNode(id);
  return (
    <CardMessage text={t("canvas.nodes.card.charged")} overImage={overImage}>
      <Button
        variant="ghost-accent"
        size="s"
        icon={Play}
        data-node-primary
        className="nodrag"
        onClick={(event) => {
          event.stopPropagation();
          void run("node");
          focusNodeSoon(id);
        }}
      >
        {t("canvas.nodes.state.runAgain")}
      </Button>
    </CardMessage>
  );
}

/** Progress / Bar on the card's bottom edge while it generates (XmhDU). */
function Progress({ id }: { id: string }) {
  const runtime = useNodeRuntime(id);
  const share =
    runtime?.progress ??
    (runtime && runtime.total > 0 && runtime.done > 0 ? runtime.done / runtime.total : null);
  return (
    <ProgressBar
      value={share ?? undefined}
      label={t("canvas.nodes.state.generating")}
      className="absolute bottom-0 left-0 w-full"
    />
  );
}
