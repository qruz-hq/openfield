import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import type { NodeDisplay, PortSpec } from "@openfield/canvas/engine/types";
import {
  LAYERS_INPUT,
  LAYERS_MEDIA_HEIGHT,
  LAYERS_ROW_HEIGHT,
  type LayersParams,
  layerOutputs,
  layerRows,
  layersModelKeyOf,
  layersSpec,
} from "@openfield/canvas/nodes/layers/spec";
import { linkedPorts } from "@openfield/canvas/nodes/registry";
import { t } from "@openfield/core";
import type { CanvasNodeResult, CanvasOutput } from "@openfield/core/canvas";
import { IconButton } from "@openfield/ui";
import {
  Check,
  CircleAlert,
  CircleStop,
  Clock3,
  Ellipsis,
  Image as ImageIcon,
  Info,
  Layers,
  Loader,
  Lock,
} from "lucide-react";
import { memo, useMemo } from "react";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas, useNodeResult, useNodeRuntime, useReadOnly } from "../../store/context";
import { CardImage, CardPill, type CardPillProps } from "../generate/card";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { BlockedMessage, CanceledMessage, FailedMessage, StopButton } from "../shell/image-card";
import { NodeShell, useCardMenu } from "../shell/node-shell";
import { RunPill } from "../shell/run-pill";
import { clock, useElapsed } from "../shell/state-band";
import { AssetImage } from "../shell/thumb";
import { useNodeBasics, useNodeDisplay, useParsedParams } from "../shell/use-node";

// Canvas / Node / Layers (design AvNxGiFbq7; Ready hJET2AMcq3, Separating wTRrNWjboM): the image
// coming in, 240 tall, then one 40 tall row per layer its last run made, top first and the base
// last, each with its own output port at the row's middle. Before a run the rows are a hint and
// the image waits under the scrim with Run in the middle; while it runs a band of light sweeps
// across the image. Failed, blocked and stopped say so over the image, as an image card does.
// What to separate, the model and the size live in its side sheet (layers-inspector.tsx).

const NO_LINKS = "";

/** This node's rail: its input, then a port per row. Follows its result and its links. */
function useLayerRail(id: string, result: CanvasNodeResult | null): readonly PortSpec[] {
  // The outputs something is linked to, as a key, so a link elsewhere on the canvas doesn't re-render.
  const linked = useCanvas((s) => [...linkedPorts(s.doc, id)].sort().join(",") || NO_LINKS);
  return useMemo(() => {
    const set = new Set(linked ? linked.split(",") : []);
    return [LAYERS_INPUT, ...layerRows({ result, linked: () => set })];
  }, [linked, result]);
}

export const LayersNode = memo(function LayersNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<LayersParams>(id, layersSpec, ctx);
  const result = useNodeResult(id);
  const display = useNodeDisplay(id);
  const rail = useLayerRail(id, result);

  if (!basics) return null;
  const { frame } = basics;
  const name = frame.title?.trim() || t(layersSpec.label);
  const made = layerOutputs(result);
  const thumbs = [...made.values()].map((o) => o.assetId);

  return (
    <NodeShell
      {...props}
      variant="card"
      spec={layersSpec}
      ports={rail}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={display.state === "stale"}
      fanOut={display.fanOut}
      inspectable
      collapsedMeta={
        <span className="truncate text-caption text-text-secondary">
          {made.size
            ? t("canvas.nodes.layers.count", { count: made.size - 1 })
            : t("canvas.nodes.layers.hint")}
        </span>
      }
      collapsedStatus={<CollapsedStatus display={display} />}
      thumbs={thumbs}
    >
      <LayersCard
        id={id}
        name={name}
        selected={props.selected}
        display={display}
        params={params}
        rail={rail}
      />
    </NodeShell>
  );
});

interface LayersCardProps {
  id: string;
  name: string;
  selected: boolean;
  display: NodeDisplay;
  params: LayersParams;
  rail: readonly PortSpec[];
}

/** Card (sSJfv7siXk): Media, then Outputs. */
function LayersCard({ id, name, selected, display, params, rail }: LayersCardProps) {
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const analysis = useNodeAnalysis(id);
  const result = useNodeResult(id);
  const menu = useCardMenu();
  const readOnly = useReadOnly();
  const solo = useCanvas((s) => s.selection.nodeIds.length === 1);
  const key = layersModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const made = layerOutputs(result);
  const rows = rail.filter((p) => p.direction === "out");
  // The image being split, else the base of the last split when nothing comes in now.
  const image = analysis?.baseImages?.[0] ?? made.get("base")?.assetId ?? null;
  const state = display.state;
  const busy = state === "queued" || state === "running";
  // Never run, or nothing on show: the image waits under the scrim with Run in the middle.
  const ready = !busy && rows.length === 0 && (state === "idle" || state === "stale" || state === "done");
  const run = (
    <RunPill
      id={id}
      name={name}
      estimate={analysis?.estimate ?? null}
      blocker={display.blocker}
      upToDate={analysis?.upToDate ?? false}
      seedless
      models={[model]}
      primary
      // Over the image and its scrim, which are placed absolutely.
      className={ready ? "relative" : undefined}
    />
  );

  return (
    <>
      <div className="of-card of-layers" data-bars={(selected && solo) || !!menu?.isOpen || undefined}>
        <div className="of-layers-media" data-ready={ready || undefined}>
          {image ? (
            <CardImage assetId={image} height={LAYERS_MEDIA_HEIGHT} contain={false} opacity={1} />
          ) : null}
          {ready || busy || (state !== "done" && state !== "stale" && state !== "idle") ? (
            <div aria-hidden className="of-layers-scrim" />
          ) : null}
          {state === "running" ? <div aria-hidden className="of-layers-sweep" /> : null}
          {ready ? (
            run
          ) : (
            <>
              <div className="of-layers-top" data-paint="dark">
                <LayersPill id={id} display={display} layers={Math.max(0, made.size - 1)} />
                <span className="h-1 flex-1" />
                {readOnly ? null : (
                  <IconButton
                    variant="overlay"
                    size={32}
                    icon={Ellipsis}
                    label={t("canvas.nodes.menu.label")}
                    className="of-reveal nodrag"
                    onClick={(event) => {
                      event.stopPropagation();
                      menu?.open(event.currentTarget);
                    }}
                  />
                )}
              </div>
              <MediaMessage id={id} display={display} model={key} />
              <div className="of-layers-action" data-paint="dark">
                {busy ? (
                  <StopButton id={id} name={name} cancel={state === "queued"} />
                ) : (
                  <span className="of-reveal">{run}</span>
                )}
              </div>
            </>
          )}
        </div>
        {rows.length ? (
          <div className="of-layers-outputs">
            {rows.map((port) => (
              <LayerRow key={port.id} port={port} made={made.get(port.id)} />
            ))}
          </div>
        ) : busy ? (
          <div className="of-layers-foot gap-8" aria-hidden>
            <span className="h-8 w-120 rounded-4 bg-elevated-2" />
            <span className="h-8 w-64 rounded-4 bg-elevated-2" />
          </div>
        ) : (
          <div className="of-layers-foot">
            <p className="text-caption text-text-tertiary">{t("canvas.nodes.layers.hint")}</p>
          </div>
        )}
      </div>
      {/* Before its first run: where its layers will come out, not yet a port. */}
      {rows.length === 0 ? (
        <span aria-hidden className="of-layers-placeholder-port">
          <ImageIcon size={12} />
        </span>
      ) : null}
    </>
  );
}

/** The pill over the image: "4 layers and a base" when done, else the state. */
function LayersPill({ id, display, layers }: { id: string; display: NodeDisplay; layers: number }) {
  const runtime = useNodeRuntime(id);
  const running = display.state === "running";
  const elapsed = useElapsed(runtime?.startedAt ?? null, running);
  const pill = ((): CardPillProps => {
    switch (display.state) {
      case "queued":
        return { icon: Clock3, label: t("canvas.nodes.state.waiting") };
      case "running":
        return {
          icon: Loader,
          spin: true,
          label: t("canvas.nodes.layers.separating"),
          value: clock(elapsed),
        };
      case "failed":
        return { icon: CircleAlert, tone: "danger", label: t("canvas.nodes.card.failed") };
      case "blocked":
        return { icon: Info, label: t("canvas.nodes.card.cantRun") };
      case "canceled":
        return { icon: CircleStop, label: t("canvas.nodes.card.canceled") };
      case "stale":
        return {
          dot: true,
          label:
            display.chip === "older_settings"
              ? t("canvas.nodes.state.olderSettings")
              : t("canvas.nodes.state.inputsChanged"),
        };
      default:
        if (display.locked) return { icon: Lock, label: t("canvas.nodes.state.locked") };
        return layers > 0
          ? { icon: Layers, label: t("canvas.nodes.layers.count", { count: layers }) }
          : { icon: Check, label: t("canvas.nodes.state.upToDate") };
    }
  })();
  return <CardPill {...pill} />;
}

/** What went wrong or what it needs, over the image: the image card's own messages. */
function MediaMessage({ id, display, model }: { id: string; display: NodeDisplay; model: string | null }) {
  const message =
    display.state === "failed" ? (
      <FailedMessage id={id} model={model} overImage />
    ) : display.state === "blocked" && display.blocker ? (
      <BlockedMessage id={id} blocker={display.blocker} overImage />
    ) : display.state === "canceled" ? (
      <CanceledMessage id={id} overImage />
    ) : null;
  return message ? <div className="of-layers-message">{message}</div> : null;
}

/** Output · {name} (oH1BxKKt3A): a 28 thumb, the name and the model's description, one line each. */
function LayerRow({ port, made }: { port: PortSpec; made: CanvasOutput | undefined }) {
  const image = port.gone ? null : (made?.assetId ?? null);
  // The model's description, or for a plain base what it is; a place the last run didn't make says so.
  const description = port.gone
    ? t("canvas.nodes.layers.gone")
    : made?.layer?.description?.trim() || (port.id === "base" ? t("layers.baseDescription") : "");
  return (
    <div className="of-layers-row" data-gone={port.gone || undefined} style={{ height: LAYERS_ROW_HEIGHT }}>
      <span className="of-layers-thumb">
        <span className="of-layers-crop">
          {image ? (
            <AssetImage assetId={image} height={24} fit="contain" className="size-full bg-transparent" pane />
          ) : null}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-caption font-medium text-text-primary">{port.name}</span>
        {description ? (
          <span className="truncate text-micro text-text-tertiary" title={description}>
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
