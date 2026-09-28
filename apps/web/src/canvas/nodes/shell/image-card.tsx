import type { NodeBlocker, NodeDisplay } from "@openfield/canvas/engine/types";
import { type CostEstimate, type ModelListItem, t } from "@openfield/core";
import { Button, IconButton, ProgressBar } from "@openfield/ui";
import {
  Check,
  CircleAlert,
  CircleStop,
  Clock3,
  Ellipsis,
  Hourglass,
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
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { useProviders } from "../../../api/hooks/keys";
import { companyName } from "../../../lib/provider";
import { useCanvas, useNodeRuntime, useReadOnly } from "../../store/context";
import { CardMessage, CardPill, type CardPillProps } from "../generate/card";
import { type CardView, cardView, hasScrim } from "../generate/card-state";
import { voxelsSupported } from "../generate/voxel/renderer";
import { VoxelField } from "../generate/voxel/voxel-field";
import { useCompanyWait } from "./company-wait";
import { focusNodeSoon } from "./focus";
import { useCardMenu } from "./node-shell";
import { RunPill } from "./run-pill";
import { clock, useBlockedMessage, useBlockerFix, useCancel, useElapsed, useFailureFix } from "./state-band";
import { useRunNode } from "./use-node";

// An image card (Generate, design Y5jjx; Variations, design njYDO): the node is its images. At
// rest: the images, the label and the ports, and a pill only when the state needs attention. On
// hover, keyboard focus, or as the only node selected: the top bar (pill, the node's own extras,
// menu) and the bottom bar (the words that run and Run, or Stop / Cancel while it runs). Every state
// the card can be in (card-state.ts) looks the same on both kinds of card; each kind brings only its
// media, its words and what shows in an empty card.

export interface ImageCardProps {
  id: string;
  name: string;
  selected: boolean;
  display: NodeDisplay;
  /** It has images from a run (the last good ones stay after a failure). */
  hasImages: boolean;
  /** A preview frame of the image being made has arrived. */
  partial?: boolean;
  /** The card's box, for the voxel swarm. */
  box: { w: number; h: number };
  /** Under 300 wide: the words get the full width and Run sits under them. */
  narrow?: boolean;
  /** Under 240 tall: a message state keeps the words to one line. */
  short?: boolean;
  /** It shows one of several images (the pager). */
  several?: boolean;
  /** Where the swarm's puffs come in. Generate's own ports by default. */
  rail?: ComponentProps<typeof VoxelField>["rail"];
  /** What fills the card, at `opacity` (dimmed under a run, faded when out of date). */
  media: (opacity: number, view: CardView) => ReactNode;
  /** In the top bar between the pill and the menu (Generate's pager). */
  topExtra?: ReactNode;
  /** What sits in the middle of an empty card. */
  empty: (view: CardView) => ReactNode;
  /** The bottom bar's words. */
  text: (view: CardView) => ReactNode;
  run: {
    estimate: CostEstimate | null;
    blocker: NodeBlocker | null;
    upToDate: boolean;
    seedless: boolean;
    models: readonly (ModelListItem | undefined)[];
    /** Nothing to run yet: Run shows, quieter. */
    muted: boolean;
  };
  /** The model a failure message names. */
  model: string | null;
}

/** Media (g0PW4) and its layers, in paint order: media, swarm, Stripes, Top, Bottom, Center, Progress. */
export function ImageCard({
  id,
  name,
  selected,
  display,
  hasImages,
  partial = false,
  box,
  narrow = false,
  short = false,
  several = false,
  rail,
  media,
  topExtra,
  empty,
  text,
  run,
  model,
}: ImageCardProps) {
  const menu = useCardMenu();
  const readOnly = useReadOnly();
  const wait = useCompanyWait(id);
  // Selected on its own, the card keeps its bars (and while its menu is open); in a
  // multi-selection only the outline shows.
  const solo = useCanvas((s) => s.selection.nodeIds.length === 1);
  const bars = (selected && solo) || !!menu?.isOpen;
  // The voxel swarm needs WebGL, set up the first time a card runs or waits.
  const live = display.state === "running" || display.state === "queued";
  const voxels = useMemo(() => live && voxelsSupported(), [live]);
  const view = cardView({ state: display.state, images: hasImages, atCompany: !!wait, partial, voxels });
  const scrim = hasScrim(view);
  // Over an image the bars and what's on them are dark in both themes (nodes.css).
  const paint = scrim ? "dark" : undefined;
  const opacity = view.media === "dimmed" ? 0.5 : view.media === "faded" ? 0.6 : 1;

  return (
    <div
      className="of-card"
      data-media={view.media === "placeholder" ? "placeholder" : "image"}
      data-tone={view.phase === "failed" ? "danger" : undefined}
      data-scrim={scrim || undefined}
      data-bars={bars || undefined}
      data-narrow={narrow || undefined}
      data-several={several || undefined}
      data-short={short || undefined}
      data-message={view.message || undefined}
      data-phase={view.phase}
    >
      {media(opacity, view)}
      {view.voxels ? (
        <VoxelField
          nodeId={id}
          mode={view.voxels}
          backing={view.media !== "placeholder"}
          width={box.w}
          height={box.h}
          {...(rail !== undefined && { rail })}
        />
      ) : null}
      {view.stripes ? <div aria-hidden className="of-card-stripes of-blocked-stripes" /> : null}
      <div className="of-card-top" data-paint={paint}>
        {view.noPill ? null : <StatusPill id={id} view={view} display={display} />}
        {topExtra}
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
        <div className="of-card-text">{text(view)}</div>
        {view.action === "run" ? (
          <RunPill
            id={id}
            name={name}
            estimate={run.estimate}
            blocker={run.blocker}
            upToDate={run.upToDate}
            seedless={run.seedless}
            models={run.models}
            muted={run.muted}
            primary
          />
        ) : view.action ? (
          <StopButton id={id} name={name} cancel={view.action === "cancel"} />
        ) : null}
      </div>
      <div className="of-card-center" data-over-image={(view.message && scrim) || undefined}>
        {view.emptyGlyph ? empty(view) : null}
        {view.message ? (
          <Message id={id} view={view} display={display} model={model} overImage={scrim} />
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
