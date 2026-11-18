import { canReblend, editKeepRestOf } from "@openfield/canvas/nodes/edit/keep-rest";
import { editSpec } from "@openfield/canvas/nodes/edit/spec";
import { type AssetListItem, type KeepRestState, t } from "@openfield/core";
import {
  Button,
  Field,
  IconButton,
  Modal,
  ModalClose,
  ModalDescription,
  ModalSurface,
  ModalTitle,
  SliderRow,
  Spinner,
} from "@openfield/ui";
import { X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeepRest } from "../../../api/hooks/keep-rest";
import { useAssetDetail } from "../../../api/hooks/library";
import { errorMessage, rawFetch, toApiError } from "../../../api/raw";
import { ZoomControl } from "../../../detail/edit/chrome";
import type { FixBrush, FixLayer } from "../../../detail/edit/fix-layer";
import { encodeFixes, readFixes } from "../../../detail/edit/fix-png";
import { type KeepRestValues, SourcesLayer, SourcesLegend } from "../../../detail/edit/keep-rest-preview";
import { useSpaceHeld } from "../../../detail/edit/paint-surface";
import { BRUSH_SLIDER_STEPS, brushSizeAt, sliderOfSize } from "../../../detail/edit/session";
import { TouchUpToolbar, useTouchUpSurface } from "../../../detail/edit/touch-up";
import { listItemOf } from "../../../detail/format";
import { Media, type MediaHandle, type MediaInset } from "../../../detail/media";
import { notifyError } from "../../../lib/notify";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas, useCanvasActions, useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { useOpenerFocus } from "./mask-window";
import { rememberTouchUp, useKeepRestCommit } from "./reblend";

// Canvas / Mask window / Touch up (design i2iySzYlSg): the mask window's shell, 1152 wide, opened
// from Fix spots by hand on an Edit node that ran. The stage is the Edit tab's Touch up: where each
// part of the result comes from over the original, the two brushes and Undo under it, Brush size
// and the legend beside it. Each stroke previews at once, for free. Apply blends the node's images
// again with the fix layer, for free, as one undo step: the node stays done and what reads it goes
// out of date. Cancel, Close and Esc leave everything as it was.

/** Room round the photo in the 560-tall stage, as in the mask window: it fits above the toolbar. */
const STAGE_INSET: MediaInset = { top: 16, right: 16, bottom: 84, left: 16 };

/** The brush starts at 4% of the short side, as in the Edit tab: touching up is fine work. */
const TOUCH_BRUSH_SHARE = 0.04;

/** Opens on the node the editor says (ui.touchUpNodeId), while its result can still be touched up. */
export function TouchUpWindow({ nodeId }: { nodeId: string }) {
  const actions = useCanvasActions();
  const frame = useNodeFrame(nodeId);
  const locked = useLocked(nodeId);
  const readOnly = useReadOnly();
  // The node's images share a fix layer: it's painted on the first and blends all of them.
  const analysis = useNodeAnalysis(nodeId);
  // Only while a change is free: a node gone out of date makes new images on its next Run instead.
  const free = useCanvas((s) =>
    canReblend(s.doc, nodeId, s.fingerprints[nodeId], analysis?.inputsChanged ?? false),
  );
  const first = useCanvas((s) => s.doc.results[nodeId]?.assetIds[0] ?? null);
  const query = useKeepRest(first);
  const state = query.data;
  const base = useAssetDetail(state?.base?.assetId ?? null);
  const detail = base.data?.asset;
  const item = useMemo(() => (detail ? listItemOf(detail) : undefined), [detail]);
  const close = useCallback(() => actions.setUi({ touchUpNodeId: null }), [actions]);
  const returnFocus = useOpenerFocus(nodeId, "touchUpNodeId");
  const open =
    !!frame &&
    frame.type === editSpec.type &&
    !locked &&
    !readOnly &&
    free &&
    first !== null &&
    state?.available !== false;
  useEffect(() => {
    if (!open) close();
  }, [open, close]);
  const failure = query.error ?? base.error;
  useEffect(() => {
    if (!failure) return;
    notifyError(errorMessage(failure));
    close();
  }, [failure, close]);
  if (!open || failure) return null;
  return (
    <Modal open onOpenChange={(next) => !next && close()}>
      {state && item ? (
        <TouchUpBody
          nodeId={nodeId}
          state={state}
          item={item}
          onClose={close}
          onCloseAutoFocus={returnFocus}
        />
      ) : (
        <TouchUpLoading onCloseAutoFocus={returnFocus} />
      )}
    </Modal>
  );
}

function TouchUpHeader({ closing = true }: { closing?: boolean }) {
  return (
    <div className="flex w-full items-start justify-between">
      {/* Title */}
      <div className="flex flex-col gap-4">
        <ModalTitle>{t("canvas.nodes.edit.touchUpWindow.title")}</ModalTitle>
        <ModalDescription>{t("canvas.nodes.edit.touchUpWindow.hint")}</ModalDescription>
      </div>
      <ModalClose asChild>
        <IconButton icon={X} label={t("actions.close")} disabled={!closing} />
      </ModalClose>
    </div>
  );
}

/** The window's frame while the edit's details load: the stage waits, and only Cancel works. */
function TouchUpLoading({ onCloseAutoFocus }: { onCloseAutoFocus: (event: Event) => void }) {
  return (
    <ModalSurface className="w-1152 gap-20 p-24" aria-busy onCloseAutoFocus={onCloseAutoFocus}>
      <TouchUpHeader />
      <div className="flex h-560 w-full min-w-0 gap-16">
        <div className="flex h-full min-w-0 flex-1 items-center justify-center rounded-14 bg-canvas">
          <Spinner size={18} />
        </div>
        <div className="h-full w-300 shrink-0" />
      </div>
      <Footer applying={false} canApply={false} onApply={noop} />
    </ModalSurface>
  );
}

function Footer({
  applying,
  canApply,
  onApply,
}: {
  applying: boolean;
  canApply: boolean;
  onApply: () => void;
}) {
  return (
    <div className="flex w-full items-center justify-end gap-8">
      <ModalClose asChild>
        <Button variant="secondary" size="m" disabled={applying}>
          {t("actions.cancel")}
        </Button>
      </ModalClose>
      <Button variant="primary" size="m" loading={applying} disabled={!canApply} onClick={onApply}>
        {t("canvas.nodes.edit.touchUpWindow.apply")}
      </Button>
    </div>
  );
}

function TouchUpBody({
  nodeId,
  state,
  item,
  onClose,
  onCloseAutoFocus,
}: {
  nodeId: string;
  state: KeepRestState;
  item: AssetListItem;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const ctx = useCanvasEngineContext();
  const params = useCanvas((s) => s.doc.params[nodeId]);
  const { commit, busy } = useKeepRestCommit(nodeId);
  const stage = useRef<HTMLDivElement>(null);
  const media = useRef<MediaHandle>(null);
  const [zoom, setZoom] = useState(0);
  const [brush, setBrush] = useState<FixBrush>("model");
  const width = state.base?.width ?? item.width;
  const height = state.base?.height ?? item.height;
  const [size, setSize] = useState(() =>
    Math.max(1, Math.round(Math.min(width, height) * TOUCH_BRUSH_SHARE)),
  );
  const fixes = useStoredFixes(state, width, height);
  const [fixesVersion, setFixesVersion] = useState(0);
  const spaceHeld = useSpaceHeld(true);
  const panning = spaceHeld || busy;

  // The node's own settings: the preview shows what Apply would make.
  const values: KeepRestValues = useMemo(() => {
    const k = editKeepRestOf(params ?? {}, ctx);
    return { keep: k.keep, sensitivity: k.sensitivity, featherPx: k.featherPx, expandPx: k.expandPx };
  }, [params, ctx]);

  // A stroke changes the fix layer in place; the preview draws again once a frame.
  const frame = useRef(0);
  const redraw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setFixesVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const touch = useTouchUpSurface({
    fixes,
    brush,
    size,
    zoom,
    panning,
    onChange: (rect) => rect && redraw(),
  });
  const undo = () => {
    if (fixes?.undo()) redraw();
  };

  const apply = async () => {
    if (!fixes?.changed || busy) return;
    try {
      // What the images were blended with before, so undo can put it back.
      const before = editKeepRestOf(params ?? {}, ctx).touchUp;
      const was = state.fixesUrl ? await fetchBlob(state.fixesUrl) : "clear";
      const png = await encodeFixes(fixes);
      const hash = await shortHash(png);
      rememberTouchUp(before, was);
      rememberTouchUp(hash, png);
      if (await commit({ touchUp: hash }, "touchUp", { fixes: png })) onClose();
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  // Undo takes the last stroke; zoom keys as in the mask window. Fields keep their own keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (busy) return;
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "z") undo();
    // Nothing here is text to select, and the page behind the window mustn't be selected either.
    else if (mod && event.key.toLowerCase() === "a") {
      // Handled: nothing to do.
    } else if (mod || event.altKey) handled = false;
    else if (event.key === "+" || event.key === "=") media.current?.zoomIn();
    else if (event.key === "-" || event.key === "_") media.current?.zoomOut();
    else if (event.key === "0") media.current?.fit();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const preview = { state, values, fixes, fixesVersion };
  const title = t("canvas.nodes.edit.touchUpWindow.title");
  return (
    <ModalSurface
      className="w-1152 gap-20 p-24"
      data-touch-up-window
      onKeyDown={onKeyDown}
      // The stage takes focus, so holding Space pans rather than pressing Close.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        stage.current?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <TouchUpHeader closing={!busy} />
      {/* Editor */}
      <div className="flex h-560 w-full min-w-0 gap-16">
        {/* Stage */}
        <div
          ref={stage}
          tabIndex={-1}
          className="relative h-full min-w-0 flex-1 overflow-hidden rounded-14 bg-canvas outline-none"
        >
          {fixes ? (
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
                layer={<SourcesLayer {...preview}>{touch.layer}</SourcesLayer>}
              >
                {busy ? null : touch.input}
              </Media>
              <TouchUpToolbar
                brush={brush}
                onBrush={setBrush}
                canUndo={fixes.canUndo}
                onUndo={undo}
                className="absolute bottom-12 left-1/2 -translate-x-1/2"
              />
              <ZoomControl
                zoom={zoom}
                onZoomIn={() => media.current?.zoomIn()}
                onZoomOut={() => media.current?.zoomOut()}
                className="bottom-12 left-12"
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Spinner size={18} />
            </div>
          )}
        </div>
        {/* Settings */}
        <div className="flex h-full w-300 shrink-0 flex-col gap-12 overflow-y-auto">
          {/* Brush */}
          <div
            inert={busy}
            className="flex w-full flex-col gap-12 rounded-14 bg-surface p-12"
            data-touch-up-brush
          >
            <Field label={t("canvas.nodes.edit.maskWindow.brushSize")} className="p-0">
              <SliderRow
                value={[sliderOfSize(size)]}
                min={0}
                max={BRUSH_SLIDER_STEPS}
                step={1}
                onValueChange={([next]) => next !== undefined && setSize(brushSizeAt(next, size))}
                thumbValueText={t("edit.options.px", { value: size })}
                valueLabel={t("edit.options.px", { value: size })}
                valueClassName="w-48"
              />
            </Field>
          </div>
          {/* Legend: a card here, not the pill under the image in the Edit tab. */}
          <SourcesLegend
            marks={state.start === "marks"}
            className="static h-auto w-full translate-x-0 flex-col items-start gap-10 rounded-14 bg-surface p-12 inset-ring-0 backdrop-blur-none"
          />
        </div>
      </div>
      <Footer applying={busy} canApply={!!fixes?.changed} onApply={() => void apply()} />
    </ModalSurface>
  );
}

const noop = () => {};

/** The edit's stored fix layer, so new strokes add to it; empty when none was painted. */
function useStoredFixes(state: KeepRestState, width: number, height: number): FixLayer | null {
  const [fixes, setFixes] = useState<FixLayer | null>(null);
  const url = state.fixesUrl;
  useEffect(() => {
    let live = true;
    readFixes(url, width, height).then(
      (layer) => live && setFixes(layer),
      (error) => live && notifyError(errorMessage(error)),
    );
    return () => {
      live = false;
    };
  }, [url, width, height]);
  return fixes;
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await rawFetch(url);
  if (!res.ok) throw await toApiError(res);
  return res.blob();
}

/** The first 12 hex of the PNG's SHA-256: the node's touch up, in its fingerprint. */
async function shortHash(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(digest.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}
