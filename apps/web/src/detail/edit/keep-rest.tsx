import { KEEP_REST_SENSITIVITY, MASK_COMPOSITE_MAX_PX, t } from "@openfield/core";
import { Button, cn, Field, SliderRow, Switch } from "@openfield/ui";
import { ImagePlus, Info, type LucideIcon, Zap } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

// Image edit / Keep the rest / Smart (design F5LM87HnMd): put the original back wherever the model
// didn't really change it, on by default. Sensitivity says how readily small changes count, Feather
// and Expand how far the mask grows and how soft its edge is. Off before a run, the model may change
// anything and the three rest at 40%. After a run the block is live on the result on show: every
// change previews at once from the model's own result (Smart / After run), which can also be saved
// as an image of its own, and the Apply bar settles it. The canvas Edit node's settings use it too.

export interface KeepRestProps {
  composite: boolean;
  featherPx: number;
  expandPx: number;
  resting: boolean;
  /** New images are in: Feather and Expand say they apply to the next Generate, unless `live`. */
  afterRun: boolean;
  /**
   * Sketch & point (design Smart / Sketch): off by default, so the change can blend in, and just
   * the switch. On, Sensitivity shows; Feather and Expand don't apply to marks.
   */
  sketch?: boolean;
  onComposite: (composite: boolean) => void;
  onFeatherPx: (px: number) => void;
  onExpandPx: (px: number) => void;
  /** 0 to 100. Left out, the Sensitivity row isn't shown. */
  sensitivity?: number;
  onSensitivity?: (sensitivity: number) => void;
  /** After a run, on a result whose model result is kept: changes preview on it for free. */
  live?: boolean;
  /** An edit that can't be adjusted (Smart / Old edit): the switch shows how it was made, nothing moves. */
  locked?: boolean;
  /** A line under the switch: why the mask alone decided, or why the edit can't be adjusted. */
  note?: string;
  /** The mask alone decided (Smart / Kept by mask only): Sensitivity rests, Feather and Expand work. */
  maskOnly?: boolean;
  /** Model's own result, with Save as new image. Left out, the row isn't shown. */
  onSaveResult?: () => void;
  savingResult?: boolean;
  /** "Changes here update the result for free", for a surface with no Apply bar. */
  freeHint?: boolean;
  /** The Apply bar, at the block's end, while something isn't applied. */
  applyBar?: ReactNode;
}

/** One line with a 14px icon: the note under the switch, or the free hint. */
function IconLine({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex w-full items-center gap-8 px-2">
      <Icon size={14} aria-hidden className="shrink-0 text-text-secondary" />
      <p className="min-w-0 flex-1 text-caption text-text-secondary">{children}</p>
    </div>
  );
}

export function KeepRest({
  composite,
  featherPx,
  expandPx,
  resting,
  afterRun,
  sketch = false,
  onComposite,
  onFeatherPx,
  onExpandPx,
  sensitivity,
  onSensitivity,
  live = false,
  locked = false,
  note,
  maskOnly = false,
  onSaveResult,
  savingResult = false,
  freeHint = false,
  applyBar,
}: KeepRestProps) {
  // Named by its field's label. The field rests as a whole; the slider doesn't dim twice.
  const slider = (
    value: number,
    max: number,
    shown: string,
    onChange: ((value: number) => void) | undefined,
    still: boolean,
  ) => (
    <SliderRow
      value={[value]}
      min={0}
      max={max}
      step={1}
      disabled={still}
      onValueChange={([next]) => next !== undefined && onChange?.(next)}
      valueLabel={shown}
      className="data-disabled:opacity-100"
    />
  );
  const description = composite
    ? sketch
      ? "edit.keep.sketchOn"
      : "edit.keep.on"
    : live
      ? "edit.keep.offAfter"
      : sketch
        ? "edit.keep.sketchOff"
        : "edit.keep.off";
  // Feather and Expand speak of the next Generate once new images are in, unless they change those.
  const next = afterRun && !live && !locked;
  const edgeStill = !composite || locked;
  const sensitivityStill = edgeStill || maskOnly;
  return (
    // Image edit / Keep the rest / Smart: a column, 4 apart.
    <div inert={resting} className={cn("flex w-full shrink-0 flex-col gap-4", resting && "opacity-45")}>
      <Field layout="inline" label={t("edit.keep.label")} description={t(description)} className="px-2 py-4">
        <Switch checked={composite} disabled={locked} onCheckedChange={onComposite} />
      </Field>
      {note ? <IconLine icon={Info}>{note}</IconLine> : null}
      {sensitivity !== undefined && (!sketch || composite) ? (
        <Field
          label={t("edit.keep.sensitivity")}
          description={t("edit.keep.sensitivityHint")}
          inert={sensitivityStill}
          className={cn("px-2 py-4", sensitivityStill && "opacity-40")}
        >
          {slider(
            sensitivity,
            KEEP_REST_SENSITIVITY.max,
            t("edit.options.percent", { value: sensitivity }),
            onSensitivity,
            sensitivityStill,
          )}
        </Field>
      ) : null}
      {sketch ? null : (
        <>
          <Field
            label={t("edit.keep.feather")}
            description={t(next ? "edit.keep.featherNext" : "edit.keep.featherHint")}
            inert={edgeStill}
            className={cn("px-2 py-4", edgeStill && "opacity-40")}
          >
            {slider(
              featherPx,
              MASK_COMPOSITE_MAX_PX,
              t("edit.options.px", { value: featherPx }),
              onFeatherPx,
              edgeStill,
            )}
          </Field>
          <Field
            label={t("edit.keep.expand")}
            description={t(next ? "edit.keep.expandNext" : "edit.keep.expandHint")}
            inert={edgeStill}
            className={cn("px-2 py-4", edgeStill && "opacity-40")}
          >
            {slider(
              expandPx,
              MASK_COMPOSITE_MAX_PX,
              t("edit.options.px", { value: expandPx }),
              onExpandPx,
              edgeStill,
            )}
          </Field>
        </>
      )}
      {onSaveResult ? (
        <Field
          layout="inline"
          label={t("edit.keep.modelResult")}
          description={t("edit.keep.modelResultHint")}
          className="px-2 py-4"
        >
          <Button variant="secondary" size="s" icon={ImagePlus} loading={savingResult} onClick={onSaveResult}>
            {t("edit.keep.saveNew")}
          </Button>
        </Field>
      ) : null}
      {freeHint ? <IconLine icon={Zap}>{t("edit.keep.free")}</IconLine> : null}
      {applyBar}
    </div>
  );
}

/**
 * Image edit / Keep the rest / Apply bar (design WhwWbty0Zh): after a run, once something differs
 * from the saved image. Apply updates that image in place; Discard goes back to it. With the switch
 * off it can't be applied in place, so it offers Save as new image instead.
 */
export function ApplyBar({
  saveNew,
  busy,
  onDiscard,
  onApply,
}: {
  /** The switch is off: the primary action saves the model's own result as a new image. */
  saveNew: boolean;
  busy: boolean;
  onDiscard: () => void;
  onApply: () => void;
}) {
  // It turns up at the end of a form that scrolls: brought into view, as the slider moved is above it.
  const bar = useRef<HTMLFieldSetElement>(null);
  // A block body: newer browsers return a promise from scrollIntoView, which isn't a cleanup.
  useEffect(() => {
    bar.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <fieldset
      ref={bar}
      aria-label={t("edit.keep.pending")}
      className="flex w-full items-center gap-8 rounded-14 bg-surface py-6 pr-6 pl-12 inset-ring inset-ring-border"
    >
      {/* Off, Save as new image is a longer word: the line stays on one row. */}
      <p className="min-w-0 flex-1 text-caption text-text-secondary">
        {t(saveNew ? "edit.keep.pendingOff" : "edit.keep.pending")}
      </p>
      <Button variant="ghost" size="s" disabled={busy} onClick={onDiscard}>
        {t("edit.keep.discard")}
      </Button>
      <Button size="s" loading={busy} disabled={busy} onClick={onApply}>
        {t(saveNew ? "edit.keep.saveNew" : "edit.keep.apply")}
      </Button>
    </fieldset>
  );
}
