import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { joinPrompt } from "@openfield/canvas/engine/inputs";
import type { NodeDisplay } from "@openfield/canvas/engine/types";
import { type EditParams, editModelKeyOf, editSpec } from "@openfield/canvas/nodes/edit/spec";
import type { CardLayout } from "@openfield/canvas/nodes/generate/card-size";
import { t } from "@openfield/core";
import { Button } from "@openfield/ui";
import { Brush, Image as ImageIcon } from "lucide-react";
import { memo, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useCanvasActions, useNodeResult, useNodeRuntime, useReadOnly } from "../../store/context";
import { CardImage, CardPager, CardPartial } from "../generate/card";
import { cardMedia, showImage } from "../generate/card-media";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { ImageCard } from "../shell/image-card";
import { LinkedPrompt } from "../shell/linked-text";
import { NodeShell } from "../shell/node-shell";
import { useSyncPorts } from "../shell/sync-ports";
import { useNodeBasics, useNodeDisplay, useParsedParams } from "../shell/use-node";
import { soleBase } from "./base";
import { editLayout, showBase } from "./card-media";
import { editCardView } from "./card-state";

// Canvas / Node / Image edit (design nRuORN2ZyA): the Generate card's frame, bars and states, showing
// the image it made, or before that the image coming in to be edited. Its ports, in rail order: the
// image, the mask, words, then reference images. On hover the bottom bar has the words over Edit mask
// and Run. With no mask yet the card waits under a scrim with Paint mask in the middle (No mask,
// YyIfrxsFFt). The mask is painted in its own window (mask-window.tsx); model, sizes and Keep the
// rest live in the inspector.

const NO_IMAGES: readonly string[] = [];

export const EditNode = memo(function EditNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<EditParams>(id, editSpec, ctx);
  const result = useNodeResult(id);
  const analysis = useNodeAnalysis(id);
  const display = useNodeDisplay(id);
  const frame = basics?.frame;
  const own = result?.assetIds ?? NO_IMAGES;
  // Before it makes anything, the card shows the first image coming in and takes its shape.
  const incoming = analysis?.baseImages.find((image) => image !== null) ?? null;
  useEffect(() => showBase(id, own.length ? null : incoming), [id, own.length, incoming]);
  const layout = useEditLayout(id, frame ?? { id }, own);
  useSyncPorts(id, props.width, props.height);

  if (!frame) return null;
  const name = frame.title?.trim() || t(editSpec.label);
  const prompt = joinPrompt([analysis?.upstreamText, params.prompt]);
  const model = ctx.model(editModelKeyOf(params.model, ctx));
  const noRefs =
    model && !model.capabilities.references.supported ? t("canvas.nodes.ports.noReferences") : null;

  return (
    <NodeShell
      {...props}
      variant="card"
      spec={editSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={display.state === "stale"}
      fanOut={display.fanOut}
      portOff={{ input_images: noRefs }}
      inspectable
      collapsedMeta={
        <span className="line-clamp-2 text-caption leading-[1.4] font-normal text-text-secondary">
          {prompt}
        </span>
      }
      collapsedStatus={<CollapsedStatus display={display} />}
      thumbs={own}
    >
      <EditCard
        id={id}
        name={name}
        selected={props.selected}
        display={display}
        layout={layout}
        own={own}
        prompt={prompt}
        params={params}
      />
    </NodeShell>
  );
});

/** The card's box and the image on show: its own (with the pager's pick), else the one coming in. */
function useEditLayout(
  id: string,
  frame: { id: string; size?: { w: number; h: number } },
  own: readonly string[],
): CardLayout & { images: readonly string[] } {
  const picked = useStore(cardMedia, (s) => s.shown[id]);
  const base = useStore(cardMedia, (s) => s.bases[id]);
  const images = own.length ? own : base ? [base] : NO_IMAGES;
  const at = picked ? images.indexOf(picked) : -1;
  const assetId = images[at >= 0 ? at : 0];
  const dims = useStore(cardMedia, (s) => (assetId ? s.dims[assetId] : undefined));
  const layout = useMemo(
    () =>
      editLayout(
        frame,
        { assetIds: own },
        {
          dims: assetId && dims ? { [assetId]: dims } : {},
          shown: picked ? { [id]: picked } : {},
          bases: base ? { [id]: base } : {},
        },
      ),
    [frame, own, assetId, dims, picked, base, id],
  );
  return { ...layout, images };
}

interface EditCardProps {
  id: string;
  name: string;
  selected: boolean;
  display: NodeDisplay;
  layout: CardLayout & { images: readonly string[] };
  own: readonly string[];
  prompt: string;
  params: EditParams;
}

function EditCard({ id, name, selected, display, layout, own, prompt, params }: EditCardProps) {
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const analysis = useNodeAnalysis(id);
  const runtime = useNodeRuntime(id);
  const actions = useCanvasActions();
  const readOnly = useReadOnly();
  const key = editModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const blocker = analysis?.blocker?.kind ?? null;
  const busy = display.state === "queued" || display.state === "running";
  // A mask can be painted on one image that's here now, and not while locked.
  const paintable = !readOnly && !display.locked && soleBase(analysis) !== null;
  const covered = blocker === "no_mask" && paintable && !busy;
  const several = own.length > 1;
  const partial = display.state === "running" ? (runtime?.partialThumbUrl ?? null) : null;
  const paint = () => actions.setUi({ maskNodeId: id });
  // Edit mask beside Run, for a mask painted here; one on the Mask input is changed where it comes from.
  const maskButton =
    paintable && !analysis?.maskLinked && params.maskAssetId ? (
      <MaskButton label={t("canvas.nodes.edit.editMask")} onPaint={paint} />
    ) : null;

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
      rail={{ ports: editSpec.ports, middle: layout.h / 2 }}
      shape={(view) => editCardView(view, { own: own.length > 0, covered })}
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
      empty={(view) =>
        view.voxels ? null : <ImageIcon size={24} aria-hidden className="text-text-tertiary" />
      }
      text={(view) => (
        <p className="of-card-prompt" data-placeholder={(!prompt && view.phase === "empty") || undefined}>
          {prompt ? (
            <LinkedPrompt parts={analysis?.upstreamParts ?? []} own={params.prompt} />
          ) : view.phase === "empty" ? (
            t("edit.prompt.placeholder")
          ) : (
            ""
          )}
        </p>
      )}
      actions={maskButton}
      cover={
        covered ? (
          <>
            <MaskButton label={t("canvas.nodes.edit.paintMask")} onPaint={paint} />
            <span className="text-caption text-text-primary">{t("canvas.nodes.edit.paintHint")}</span>
          </>
        ) : undefined
      }
      run={{
        estimate: analysis?.estimate ?? null,
        blocker: display.blocker,
        upToDate: analysis?.upToDate ?? false,
        seedless: !model?.capabilities.seed.supported,
        models: [model],
        muted: blocker === "no_mask" || blocker === "no_description",
      }}
      model={key}
    />
  );
}

/** Button / Overlay / S / Icon with the brush: Paint mask in the middle, Edit mask beside Run. */
function MaskButton({ label, onPaint }: { label: string; onPaint: () => void }) {
  return (
    <Button
      variant="overlay"
      size="s"
      icon={Brush}
      className="nodrag"
      onClick={(event) => {
        event.stopPropagation();
        onPaint();
      }}
    >
      {label}
    </Button>
  );
}
