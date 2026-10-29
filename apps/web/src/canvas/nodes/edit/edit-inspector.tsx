import { speedOf } from "@openfield/canvas/engine/context-base";
import { nodeTitle } from "@openfield/canvas/engine/describe";
import { type EditParams, editModelKeyOf, editSpec, maskFitsBase } from "@openfield/canvas/nodes/edit/spec";
import { resolveFor } from "@openfield/canvas/nodes/generate/settings";
import { incomingEdges } from "@openfield/canvas/store/graph";
import { assetThumbUrl, t } from "@openfield/core";
import { type ComposerValues, type EditBase, editOpFor } from "@openfield/providers/manifest";
import { Button, cn, Divider } from "@openfield/ui";
import { Brush } from "lucide-react";
import { useNavigate } from "react-router";
import { useStore } from "zustand";
import { KeepRest } from "../../../detail/edit/keep-rest";
import { MaskThumb } from "../../../detail/edit/mask-thumb";
import { ModelField } from "../../../detail/edit/model-field";
import { SizeFields } from "../../../detail/edit/size-fields";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas, useCanvasActions, useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { cardMedia } from "../generate/card-media";
import { useModelSwitch } from "../generate/controls";
import { nodeRegistry } from "../registry";
import { InspectorRun, LOCKED_DIM } from "../shell/inspector-parts";
import { PromptCard } from "../shell/prompt-card";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";
import { soleBase, usePaintBase } from "./base";

// Canvas / Inspector / Image edit (design MZI3JqbHJr): the Mask card (the mask over the image and
// Paint), the prompt card, then the Edit tab's own Model field, Size fields (no size note) and Keep
// the rest, with the node's values, then Run. Run waits, with no price, while there's no mask, the
// mask was painted on another image, or there are no words: the card above it says why. A mask on
// the Mask input stands in for a painted one, and is changed where it comes from.

/** The canvas settings' field labels: 12/500, tertiary (design WnWS6lEX2i, WVZFuSKfP2). */
const LABEL = "text-caption font-medium text-text-tertiary";

/** What keeps Run off here: the inspector shows why above it. */
const WAITING = new Set(["no_mask", "mask_stale", "no_description"]);

export function EditInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const frame = useNodeFrame(nodeId);
  const params = useParsedParams<EditParams>(nodeId, editSpec, ctx);
  const setParams = useSetParams(nodeId);
  const switchModel = useModelSwitch(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const resting = readOnly || locked;
  const base = soleBase(analysis);
  const dims = useStore(cardMedia, (s) => (base ? s.dims[base] : undefined));
  const promptFrom = useCanvas((s) => {
    const source = incomingEdges(s.doc, nodeId, "prompt")[0]?.source;
    const node = source ? s.doc.nodes[source] : undefined;
    return node ? nodeTitle(node, nodeRegistry) : null;
  });
  const key = editModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const masked = (analysis?.maskImages.length ?? 0) > 0 || !!params.maskAssetId;
  const speed = model ? speedOf(ctx, model, editOpFor(model.capabilities, masked)) : "standard";
  const resolved = model ? resolveFor(model, params, params.batch) : undefined;
  const editBase: EditBase | null = base && dims ? { assetId: base, width: dims.w, height: dims.h } : null;
  const busy = display.state === "queued" || display.state === "running";
  const waiting = WAITING.has(analysis?.blocker?.kind ?? "");

  if (!frame) return null;
  return (
    <>
      <MaskCard nodeId={nodeId} params={params} />
      <PromptCard
        nodeId={nodeId}
        value={params.prompt}
        onChange={(prompt) => setParams({ prompt }, "prompt")}
        references={!!model?.capabilities.references.supported}
        // Words typed before a Prompt node was linked still go after its words, until cleared.
        placeholder={t(
          analysis?.upstreamText ? "canvas.nodes.generate.promptPlaceholder" : "edit.prompt.placeholder",
        )}
        fieldLabel={t("edit.prompt.label")}
        fromLabel={t("canvas.nodes.edit.fromPrompt", { name: promptFrom ?? "" })}
        thumbSize={56}
        addToLinked={false}
      />
      <ModelField
        models={ctx.models}
        selected={model}
        base={editBase}
        composite={params.keepOriginal}
        resting={resting}
        labelClassName={LABEL}
        onPick={(next) => {
          // A model whose company has no key leads to where the key goes, as in the composer.
          if (!next.ready) navigate("/settings/api-keys", { state: { focusKey: true } });
          else if (next.key !== model?.key) switchModel(model, next, params);
        }}
      />
      <SizeFields
        model={model}
        resolved={resolved}
        base={editBase}
        masked={masked}
        composite={params.keepOriginal}
        speed={speed}
        resting={resting}
        note={false}
        labelClassName={LABEL}
        onValues={(values: ComposerValues) =>
          setParams({
            ...("resolution" in values && { resolution: values.resolution }),
            ...("quality" in values && { quality: values.quality }),
          })
        }
        onBatch={(batch) => setParams({ batch }, "batch")}
      />
      <Divider />
      <KeepRest
        composite={params.keepOriginal}
        featherPx={params.featherPx}
        expandPx={params.expandPx}
        resting={resting}
        afterRun={false}
        onComposite={(keepOriginal) => setParams({ keepOriginal })}
        onFeatherPx={(featherPx) => setParams({ featherPx }, "featherPx")}
        onExpandPx={(expandPx) => setParams({ expandPx }, "expandPx")}
      />
      <InspectorRun
        estimate={waiting ? null : (analysis?.estimate ?? null)}
        models={[model]}
        disabled={readOnly || busy || waiting}
        locked={locked}
        onRun={(anchor, bypassCache) => void run("node", { anchor, bypassCache })}
      />
    </>
  );
}

/**
 * Mask card: the mask over the image, what it is, and Paint. Painted on the image coming in, not
 * painted yet, from the Mask input (no Paint), or painted on an image that has since changed.
 */
function MaskCard({ nodeId, params }: { nodeId: string; params: EditParams }) {
  const actions = useCanvasActions();
  const analysis = useNodeAnalysis(nodeId);
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const base = soleBase(analysis);
  const paintOn = usePaintBase(nodeId);
  const incoming = analysis?.baseImages ?? [];
  const linked = analysis?.maskLinked ?? false;
  const painted = params.maskAssetId ?? null;
  // The engine's own rule on the engine's own list (paintedMaskFits), while an image is connected:
  // painted on one image, anything else coming in now (another one, several, none yet) doesn't fit.
  const stale =
    !linked &&
    !!painted &&
    !!params.maskFor &&
    !!analysis?.baseLinked &&
    !maskFitsBase(params.maskFor, incoming);
  const subtitle = linked
    ? t("canvas.nodes.edit.maskLinked")
    : stale
      ? t(incoming.length > 1 ? "canvas.nodes.blocked.maskSeveral" : "canvas.nodes.blocked.maskStale")
      : painted
        ? t("canvas.nodes.edit.maskPainted")
        : t("canvas.nodes.edit.maskNone");
  const linkedImage = analysis?.maskImages.find((image) => image !== null) ?? null;
  // A thumbnail of the mask is plenty for 40 px: the full file can be tens of megapixels.
  const maskOf = (id: string | null) => (id ? assetThumbUrl(id, { h: 200 }) : null);

  return (
    <div className={cn("flex w-full items-center gap-12 rounded-14 bg-surface p-12", locked && LOCKED_DIM)}>
      {/* The mask over the image either way (Mask input, AnNJFnZm94, keeps the painted thumb). */}
      {linked ? (
        <MaskThumb imageId={base} maskUrl={maskOf(linkedImage)} wired className="size-40" />
      ) : (
        <MaskThumb
          imageId={stale ? params.maskFor! : (base ?? params.maskFor ?? null)}
          maskUrl={maskOf(painted)}
          className="size-40"
        />
      )}
      {/* Text */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-small font-medium text-text-primary">{t("canvas.nodes.edit.mask")}</span>
        <span className={cn("w-full text-caption", stale ? "text-danger" : "text-text-tertiary")}>
          {subtitle}
        </span>
      </div>
      {linked ? null : (
        <Button
          variant="secondary"
          size="s"
          icon={Brush}
          disabled={readOnly || locked || paintOn === null}
          // Locked, Paint keeps its look inside the dimmed card.
          className={locked ? "disabled:bg-elevated-2 disabled:text-text-primary" : undefined}
          onClick={() => actions.setUi({ maskNodeId: nodeId })}
        >
          {t("canvas.nodes.edit.paint")}
        </Button>
      )}
    </div>
  );
}
