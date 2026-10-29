import { type EditParams, editSpec } from "@openfield/canvas/nodes/edit/spec";
import { type AssetListItem, MASK_MAX_PIXELS, t } from "@openfield/core";
import {
  Button,
  cn,
  Divider,
  Field,
  IconButton,
  Modal,
  ModalClose,
  ModalDescription,
  ModalSurface,
  ModalTitle,
  SliderRow,
} from "@openfield/ui";
import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { saveMask } from "../../../api/hooks/edit";
import { useAssetDetail } from "../../../api/hooks/library";
import { errorMessage, rawFetch } from "../../../api/raw";
import { EditToolbar, ZoomControl } from "../../../detail/edit/chrome";
import { editKey } from "../../../detail/edit/keys";
import { decodeMaskPng, encodeMaskPng } from "../../../detail/edit/mask-png";
import { usePaintSurface, useSpaceHeld } from "../../../detail/edit/paint-surface";
import { tooLargeToMask } from "../../../detail/edit/plan";
import {
  BRUSH_SLIDER_STEPS,
  brushSizeAt,
  DEFAULT_TOOL,
  sliderOfSize,
  useEditSession,
} from "../../../detail/edit/session";
import { useTurnedPhoto } from "../../../detail/edit/turned";
import { listItemOf } from "../../../detail/format";
import { Media, type MediaHandle, type MediaInset } from "../../../detail/media";
import { notifyError } from "../../../lib/notify";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useCanvasActions, useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { useParsedParams } from "../shell/use-node";
import { soleBase } from "./base";

// Canvas / Mask window (design Q9q9tToKj4): a Modal / Shell, 1152 wide, where an Edit node's mask is
// painted on the image coming in. The stage is the Edit tab's painting (its MaskEditor session, paint
// surface, toolbar and zoom control); the brush settings sit in a card beside it. Save mask uploads
// the mask (POST /api/masks) and writes it and the image it was painted on to the node in one undo
// step. Cancel, Close and Esc leave the node as it was.

/** Room round the photo in the 560-tall stage: it fits above the toolbar (Photo at 16, 460 tall). */
const STAGE_INSET: MediaInset = { top: 16, right: 16, bottom: 84, left: 16 };

/** Opens on the node the editor says (ui.maskNodeId), while it can still take a mask. */
export function MaskWindow({ nodeId }: { nodeId: string }) {
  const actions = useCanvasActions();
  const frame = useNodeFrame(nodeId);
  const locked = useLocked(nodeId);
  const readOnly = useReadOnly();
  const base = soleBase(useNodeAnalysis(nodeId));
  const detail = useAssetDetail(base).data?.asset;
  const item = useMemo(() => (detail ? listItemOf(detail) : undefined), [detail]);
  const open = !!frame && frame.type === editSpec.type && !locked && !readOnly && base !== null;
  // A node that's gone, locked or lost its image closes the window.
  useEffect(() => {
    if (!open) actions.setUi({ maskNodeId: null });
  }, [open, actions]);
  if (!open) return null;
  return (
    <Modal open onOpenChange={(next) => !next && actions.setUi({ maskNodeId: null })}>
      {item ? <MaskWindowBody nodeId={nodeId} item={item} /> : null}
    </Modal>
  );
}

function MaskWindowBody({ nodeId, item }: { nodeId: string; item: AssetListItem }) {
  const ctx = useCanvasEngineContext();
  const actions = useCanvasActions();
  const params = useParsedParams<EditParams>(nodeId, editSpec, ctx);
  const stage = useRef<HTMLDivElement>(null);
  const media = useRef<MediaHandle>(null);
  const [zoom, setZoom] = useState(0);
  const [saving, setSaving] = useState(false);
  const tool = useEditSession((s) => s.tool);
  const mask = useEditSession((s) => s.mask);
  // The mask painted on this very image comes back to edit; one painted on another doesn't fit it.
  const existing = params.maskAssetId && params.maskFor === item.id ? params.maskAssetId : null;
  const started = useMaskSession(item, existing);
  const turned = useTurnedPhoto(item, true);
  const tooLarge = tooLargeToMask(item);
  const blocked = turned || tooLarge;
  const spaceHeld = useSpaceHeld(true);
  const panning = tool === "pan" || spaceHeld || saving;
  const paint = usePaintSurface({
    width: item.width,
    height: item.height,
    zoom,
    panning,
    enabled: started && !blocked,
    resting: saving,
  });
  const close = () => actions.setUi({ maskNodeId: null });
  // The mask and the image it fits, together, so one undo takes both back.
  const setMask = (maskAssetId: string | undefined) =>
    actions.apply(
      [{ op: "setParams", id: nodeId, patch: { maskAssetId, maskFor: maskAssetId ? item.id : undefined } }],
      { label: "mask" },
    );

  const save = async () => {
    const session = useEditSession.getState();
    const editor = session.editor;
    if (!editor || saving) return;
    // Nothing painted since it opened: the node keeps the mask it has.
    if (!session.mask.canUndo) return close();
    // All of it cleared: the node has no painted mask any more.
    if (session.mask.empty) {
      setMask(undefined);
      return close();
    }
    setSaving(true);
    try {
      const { asset } = await saveMask(await encodeMaskPng(editor.mask), item.id);
      setMask(asset.id);
      close();
    } catch (error) {
      notifyError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  // The Edit tab's keys: tool letters, undo and redo, and zoom. Fields keep their own keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']") || !started || saving) return;
    const session = useEditSession.getState();
    const edit = editKey(event);
    let handled = true;
    if (edit?.kind === "tool") session.setTool(edit.tool);
    else if (edit?.kind === "undo") session.undo();
    else if (edit?.kind === "redo") session.redo();
    else if (event.metaKey || event.ctrlKey || event.altKey) handled = false;
    else if (event.key === "+" || event.key === "=") media.current?.zoomIn();
    else if (event.key === "-" || event.key === "_") media.current?.zoomOut();
    else if (event.key === "0") media.current?.fit();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const title = t("canvas.nodes.edit.maskWindow.title");
  return (
    <ModalSurface
      className="w-1152 gap-20 p-24"
      onKeyDown={onKeyDown}
      // The stage takes focus, so holding Space pans rather than pressing Close.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        stage.current?.focus({ preventScroll: true });
      }}
      // Esc first drops what's being drawn, then puts the brush back in hand, then closes.
      onEscapeKeyDown={(event) => {
        if (paint.cancel()) return event.preventDefault();
        if (useEditSession.getState().tool !== DEFAULT_TOOL) {
          useEditSession.getState().setTool(DEFAULT_TOOL);
          event.preventDefault();
        }
      }}
    >
      {/* Header */}
      <div className="flex w-full items-start justify-between">
        {/* Title */}
        <div className="flex flex-col gap-4">
          <ModalTitle>{title}</ModalTitle>
          <ModalDescription>{t("canvas.nodes.edit.maskWindow.hint")}</ModalDescription>
        </div>
        <ModalClose asChild>
          <IconButton icon={X} label={t("actions.close")} />
        </ModalClose>
      </div>
      {/* Editor */}
      <div className="flex h-560 w-full min-w-0 gap-16">
        {/* Stage */}
        <div
          ref={stage}
          tabIndex={-1}
          className="relative h-full min-w-0 flex-1 overflow-hidden rounded-14 bg-canvas outline-none"
        >
          {blocked ? (
            <CantMask item={item} turned={turned} />
          ) : started ? (
            <>
              <Media
                ref={media}
                item={item}
                expanded={false}
                label={title}
                onZoomedChange={noop}
                onZoomChange={setZoom}
                inset={STAGE_INSET}
                panAnywhere={panning}
                layer={paint.layer}
              >
                {saving ? null : paint.input}
              </Media>
              <EditToolbar resting={saving} className="bottom-12" />
              <ZoomControl
                zoom={zoom}
                onZoomIn={() => media.current?.zoomIn()}
                onZoomOut={() => media.current?.zoomOut()}
                className="bottom-12 left-12"
              />
            </>
          ) : null}
        </div>
        {/* Settings */}
        <div className="flex h-full w-300 shrink-0 flex-col gap-12">
          <BrushSettings resting={saving || blocked} />
        </div>
      </div>
      {/* Footer */}
      <div className="flex w-full items-center justify-end gap-8">
        <ModalClose asChild>
          <Button variant="secondary" size="m">
            {t("actions.cancel")}
          </Button>
        </ModalClose>
        <Button
          variant="primary"
          size="m"
          loading={saving}
          // A trace too faint to change anything can't be saved (an empty one clears the mask).
          disabled={!started || blocked || (!mask.empty && !mask.changes)}
          onClick={() => void save()}
        >
          {t("canvas.nodes.edit.maskWindow.save")}
        </Button>
      </div>
    </ModalSurface>
  );
}

const noop = () => {};

/**
 * Starts the Edit tab's mask session on the image, with the node's own mask painted in when it was
 * painted on this image. One that can't be read is left out, to paint again. The session ends with
 * the window.
 */
function useMaskSession(item: AssetListItem, existing: string | null): boolean {
  const [started, setStarted] = useState(false);
  const detail = useAssetDetail(existing);
  const maskUrl = detail.data?.asset.fileUrl ?? null;
  const waiting = existing !== null && detail.isPending;
  const { id, width, height } = item;

  useEffect(() => {
    if (waiting) return;
    let live = true;
    const load = async () => {
      let initial: Uint8Array | undefined;
      if (maskUrl) {
        try {
          const res = await rawFetch(maskUrl);
          if (!res.ok) throw new Error(`Mask ${res.status}`);
          initial = await decodeMaskPng(await res.blob(), width, height);
        } catch {
          initial = undefined;
        }
      }
      if (!live) return;
      // A fresh session: whatever was painted before on this image elsewhere isn't this node's.
      const session = useEditSession.getState();
      session.end();
      if (!tooLargeToMask({ width, height })) session.start(id, width, height, initial);
      setStarted(true);
    };
    void load();
    return () => {
      live = false;
    };
  }, [waiting, maskUrl, id, width, height]);

  useEffect(() => () => useEditSession.getState().end(), []);
  return started;
}

/** Brush: Brush size, Hardness and Mask, each a Form / Field / Slider with dividers between. */
function BrushSettings({ resting }: { resting: boolean }) {
  const size = useEditSession((s) => s.brushSize);
  const hardness = useEditSession((s) => s.hardness);
  const opacity = useEditSession((s) => s.maskOpacity);
  const { setBrushSize, setHardness, setMaskOpacity } = useEditSession.getState();
  return (
    <div
      inert={resting}
      className={cn("flex w-full flex-col gap-12 rounded-14 bg-surface p-12", resting && "opacity-45")}
    >
      <Field label={t("canvas.nodes.edit.maskWindow.brushSize")} className="p-0">
        <SliderRow
          value={[sliderOfSize(size)]}
          min={0}
          max={BRUSH_SLIDER_STEPS}
          step={1}
          onValueChange={([value]) => value !== undefined && setBrushSize(brushSizeAt(value, size))}
          thumbValueText={t("edit.options.px", { value: size })}
          valueLabel={t("edit.options.px", { value: size })}
          valueClassName="w-48"
        />
      </Field>
      <Divider />
      <Field
        label={t("edit.options.hardness")}
        description={t("canvas.nodes.edit.maskWindow.hardnessHint")}
        className="p-0"
      >
        <SliderRow
          value={[hardness]}
          min={0}
          max={100}
          step={1}
          onValueChange={([value]) => value !== undefined && setHardness(value)}
          valueLabel={t("edit.options.percent", { value: hardness })}
          valueClassName="w-48"
        />
      </Field>
      <Divider />
      <Field
        label={t("edit.options.mask")}
        description={t("canvas.nodes.edit.maskWindow.maskHint")}
        className="p-0"
      >
        <SliderRow
          value={[opacity]}
          min={0}
          max={100}
          step={1}
          onValueChange={([value]) => value !== undefined && setMaskOpacity(value)}
          valueLabel={t("edit.options.percent", { value: opacity })}
          valueClassName="w-48"
        />
      </Field>
    </div>
  );
}

/** In place of the photo: a phone photo stored on its side, or one too large, can't take a mask. */
function CantMask({ item, turned }: { item: AssetListItem; turned: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-24">
      <p className="text-center text-body-strong text-text-primary">
        {t(turned ? "edit.turned.title" : "edit.tooLarge.title")}
      </p>
      <p className="max-w-420 text-center text-small leading-[1.45] text-text-secondary">
        {turned
          ? t("edit.turned.body")
          : t("edit.tooLarge.body", {
              width: item.width,
              height: item.height,
              megapixels: MASK_MAX_PIXELS / 1_000_000,
            })}
      </p>
    </div>
  );
}
