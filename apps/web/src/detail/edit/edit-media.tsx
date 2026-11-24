import type { AssetListItem } from "@openfield/core";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useAssetDetail } from "../../api/hooks/library";
import { thumbAt } from "../format";
import { Media, type MediaHandle, type MediaInset } from "../media";
import { BrushOptions, EditToolbar, ShapeOptions, ZoomControl } from "./chrome";
import {
  AfterLayer,
  CompareBar,
  type CompareMode,
  CompareSwitch,
  DifferenceLayer,
  DifferenceLegend,
  QuickKeepSwitch,
  ResultActions,
  SPLIT_START,
  SplitPins,
} from "./compare";
import { useKeepRestDrafts, useKeepRestLive } from "./keep-rest-draft";
import { KeptPreview, SourcesLayer, SourcesLegend } from "./keep-rest-preview";
import { usePaintSurface, useSpaceHeld } from "./paint-surface";
import { tooLargeToMask } from "./plan";
import { GeneratingLabel, ResultsStrip } from "./results";
import type { EditRunner } from "./runner";
import { useEditSession } from "./session";
import { ModeSwitch, SketchHint, SketchToolbar } from "./sketch-chrome";
import { useSketchSurface } from "./sketch-surface";
import { TouchUpToolbar, useTouchUpSurface } from "./touch-up";
import { useShownSideways, useTurnedPhoto } from "./turned";
import { useEditModel } from "./use-edit-model";

// An image in the detail view, on either tab. On Info it's Media as it always was. On Edit the same
// Media (so zoom and the loaded pixels carry over) takes the mask's layer and the pointer, with the
// toolbar, the tool's options and the zoom control floating over the media area. Once a run has
// saved new images, the one picked is compared with the original instead (compare.tsx).

/**
 * The Edit tab's room around the image (design f90S4YuAoH: a 680 tall image at 58 from the top of
 * 900): the image moves up to clear the options bar and the toolbar below it.
 */
const EDIT_INSET: MediaInset = { top: 58, right: 98, bottom: 162, left: 98 };

export interface ImageMediaHandle extends MediaHandle {
  /**
   * Esc on the Edit tab: drops a stroke, lasso or box being drawn, or ends Touch up. True when
   * there was one.
   */
  cancel: () => boolean;
  /** ⌘Z while touching up: the last stroke goes. False when not touching up. */
  undoTouch: () => boolean;
}

interface ImageMediaProps {
  item: AssetListItem;
  expanded: boolean;
  label: string;
  /** The Edit tab is open on this image. */
  editing: boolean;
  /** The Edit tab's runs: the results strip and the Generating label show them. */
  runner: EditRunner;
  onZoomedChange: (zoomed: boolean) => void;
  ref?: Ref<ImageMediaHandle>;
}

export function ImageMedia({ item, expanded, label, editing, runner, onZoomedChange, ref }: ImageMediaProps) {
  const media = useRef<MediaHandle>(null);
  const [zoom, setZoom] = useState(0);
  const tool = useEditSession((s) => s.tool);
  const sketchTool = useEditSession((s) => s.sketchTool);
  const picking = useEditSession((s) => s.selectedMark !== null);
  // Sketch & point in place of the mask, for a model that reads marks.
  const { model, sketch } = useEditModel();
  const spaceHeld = useSpaceHeld(editing);
  const turned = useTurnedPhoto(item, editing);
  const tooLarge = tooLargeToMask(item);
  // The browser draws a photo stored on its side upright, so its box is the other way round from
  // the stored size. An upload is the only kind that can be.
  const sideways = useShownSideways(item, editing || item.kind === "uploaded");
  const upright = sideways ? { ...item, width: item.height, height: item.width } : item;
  // A new image picked in the results strip: Before and after, or Difference, in place of the mask.
  const compared = editing ? runner.compared : null;
  const [mode, setMode] = useState<CompareMode>("split");
  const [split, setSplit] = useState(SPLIT_START);
  // While a run goes, and on an image that can't take a mask, the mask stays as it is.
  const resting = runner.busy || turned || tooLarge;
  const panning = editing && !compared && ((sketch ? sketchTool : tool) === "pan" || spaceHeld || resting);
  const paint = usePaintSurface({
    width: item.width,
    height: item.height,
    zoom,
    panning,
    enabled: editing && !tooLarge,
    resting: runner.busy,
  });
  const marks = useSketchSurface({ panning });
  // The strip shows a run on its way and what it made; one that came to nothing leaves it out.
  const results = runner.busy || runner.outcome.kind === "saved";

  // Keep the rest after the run, on the new image compared (design wSsx3rDRlh).
  const result = useAssetDetail(compared).data?.asset;
  const keep = useKeepRestLive(compared);
  const kept = keep.state;
  const adjustable = keep.available;
  // An edit that can't be adjusted shows its switch at rest; one made without a mask or marks has none.
  const locked = !!kept && !kept.available && kept.unavailable !== "not_an_edit";
  const values = keep.values;
  const touching = keep.touching && adjustable;
  const brush = useKeepRestDrafts((s) => s.brush);
  const brushSize = useKeepRestDrafts((s) => s.brushSize);
  const fixes = keep.draft?.fixes ?? null;
  // A stroke changes the fix layer in place; the preview draws again once a frame.
  const frame = useRef(0);
  const redraw = useCallback(() => {
    if (frame.current || !compared || !kept) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const draft = useKeepRestDrafts.getState().drafts[compared];
      useKeepRestDrafts.getState().set(compared, kept, { fixesVersion: (draft?.fixesVersion ?? 0) + 1 });
    });
  }, [compared, kept]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const touch = useTouchUpSurface({
    fixes,
    brush,
    size: brushSize,
    zoom,
    panning: spaceHeld,
    onChange: (rect) => rect && redraw(),
  });
  const undoTouch = useCallback(() => {
    if (!touching || !fixes) return false;
    if (fixes.undo()) redraw();
    return true;
  }, [touching, fixes, redraw]);
  // Touch up belongs to the image it was opened on.
  useEffect(() => {
    const store = useKeepRestDrafts.getState();
    if (store.touching && store.touching !== compared) store.setTouching(null);
  }, [compared]);
  const preview =
    kept && values && keep.draft
      ? { state: kept, values, fixes, fixesVersion: keep.draft.fixesVersion }
      : kept && values
        ? { state: kept, values, fixes: null, fixesVersion: 0 }
        : null;

  // The mask is the image's stored size; an edit already open on it carries on. One too large
  // for a mask never gets one.
  useEffect(() => {
    if (editing && !tooLarge) useEditSession.getState().start(item.id, item.width, item.height);
  }, [editing, tooLarge, item.id, item.width, item.height]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => media.current?.zoomIn(),
    zoomOut: () => media.current?.zoomOut(),
    fit: () => media.current?.fit(),
    toggle: () => media.current?.toggle(),
    cancel: () => {
      if (touching) {
        keep.endTouch();
        return true;
      }
      return sketch ? marks.cancel() : paint.cancel();
    },
    undoTouch,
  }));

  return (
    <>
      <Media
        ref={media}
        item={upright}
        expanded={expanded}
        label={label}
        onZoomedChange={onZoomedChange}
        onZoomChange={setZoom}
        inset={editing ? EDIT_INSET : undefined}
        panAnywhere={panning || (touching && spaceHeld)}
        layer={
          compared ? (
            touching && preview ? (
              <SourcesLayer {...preview}>{touch.layer}</SourcesLayer>
            ) : mode === "split" ? (
              <AfterLayer
                item={item}
                resultId={compared}
                result={result}
                split={split}
                zoom={zoom}
                // Moved and not applied: the preview stands in for the saved file.
                preview={
                  keep.pending && preview ? (
                    <KeptPreview baseUrl={thumbAt(item, "preview")} {...preview} />
                  ) : undefined
                }
              />
            ) : adjustable && preview ? (
              <SourcesLayer {...preview} />
            ) : (
              <DifferenceLayer item={item} resultId={compared} result={result} />
            )
          ) : editing && !turned && !tooLarge ? (
            sketch ? (
              marks.layer
            ) : (
              paint.layer
            )
          ) : null
        }
        pinned={
          compared ? (
            touching || (mode === "difference" && adjustable) ? (
              <SourcesLegend marks={kept?.start === "marks"} />
            ) : mode === "split" ? (
              (frame) => (
                <SplitPins
                  frame={frame}
                  split={split}
                  onSplitChange={setSplit}
                  modelResult={adjustable && values?.keep === false}
                />
              )
            ) : (
              <DifferenceLegend />
            )
          ) : editing && sketch && !turned && !tooLarge ? (
            (frame) => (
              <>
                {marks.pinned(frame)}
                {runner.busy ? <GeneratingLabel /> : null}
              </>
            )
          ) : editing && runner.busy ? (
            <GeneratingLabel />
          ) : null
        }
      >
        {editing && !resting && !compared ? (sketch ? marks.input : paint.input) : null}
        {touching ? touch.input : null}
      </Media>
      {compared ? (
        <>
          {touching ? null : (
            <CompareBar>
              <CompareSwitch mode={mode} onModeChange={setMode} />
              {(adjustable || locked) && values ? (
                <QuickKeepSwitch
                  checked={values.keep}
                  disabled={!adjustable}
                  onCheckedChange={(on) => keep.set({ keep: on })}
                />
              ) : null}
            </CompareBar>
          )}
          <ResultsStrip originalId={item.id} slots={runner.slots} shown={runner.shown} onShow={runner.show} />
          <ZoomControl
            zoom={zoom}
            onZoomIn={() => media.current?.zoomIn()}
            onZoomOut={() => media.current?.zoomOut()}
          />
          {touching && fixes ? (
            <TouchUpToolbar
              brush={brush}
              onBrush={useKeepRestDrafts.getState().setBrush}
              size={brushSize}
              onSize={useKeepRestDrafts.getState().setBrushSize}
              canUndo={fixes.canUndo}
              onUndo={undoTouch}
              onDone={keep.endTouch}
              className="absolute bottom-16 left-1/2 -translate-x-1/2"
            />
          ) : (
            <ResultActions
              sketch={sketch}
              // Sketch & point has only Touch up, unless the edit can't be touched up.
              {...((!sketch || !adjustable) && { onEditMask: () => runner.show(null) })}
              {...(adjustable && { onTouchUp: () => void keep.startTouch() })}
              touchUpBusy={keep.loadingFixes}
            />
          )}
        </>
      ) : editing ? (
        <>
          <ZoomControl
            zoom={zoom}
            onZoomIn={() => media.current?.zoomIn()}
            onZoomOut={() => media.current?.zoomOut()}
          />
          {sketch ? (
            <>
              {/* The picked mark's popover says what to do with it instead. */}
              {resting || picking ? null : <SketchHint model={model?.displayName} />}
              <SketchToolbar resting={resting} />
            </>
          ) : (
            <>
              {resting ? null : tool === "brush" || tool === "eraser" ? (
                <BrushOptions />
              ) : tool === "lasso" || tool === "rect" ? (
                <ShapeOptions tool={tool} />
              ) : null}
              <EditToolbar
                resting={resting}
                modeSwitch={model?.capabilities.marks && !tooLarge ? <ModeSwitch /> : undefined}
              />
            </>
          )}
          {results ? (
            <ResultsStrip
              originalId={item.id}
              slots={runner.slots}
              shown={runner.shown}
              onShow={runner.show}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
