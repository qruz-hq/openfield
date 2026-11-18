import { canReblend } from "@openfield/canvas/nodes/edit/keep-rest";
import type { EditParams } from "@openfield/canvas/nodes/edit/spec";
import { KEEP_REST_SENSITIVITY, type KeepRestState, MASK_COMPOSITE_MAX_PX, t } from "@openfield/core";
import { Button, cn, Field, SliderRow, Switch } from "@openfield/ui";
import { Info, type LucideIcon, Paintbrush, Zap } from "lucide-react";
import { useState } from "react";
import { useNodeAnalysis } from "../../engine/engine-store";
import { useCanvas } from "../../store/context";
import { useSetParams } from "../shell/use-node";
import { useKeepRestState } from "./keep-rest-api";
import { useKeepRestCommit } from "./reblend";

// Canvas / Inspector / Image edit / Smart's Keep the rest (design KyWrAiBwam, after a run
// 3ydiGwTdUW; Sketch & point E3SMnl1gU9 and bLxbrvpVYa): column gap 4. The switch, a note when
// only the mask decided or the edit is older than the model's kept result, Sensitivity, Feather and
// Expand (Sketch & point: Sensitivity only, once on), then after a run Fix spots by hand and the
// hint that changes here are free. On a node that's up to date, a change blends its images again
// on release, for free (reblend.ts); before a run, or once it's out of date anyway, it's a setting.

const NOTE = "text-caption text-text-secondary";

export function KeepRestBlock({
  nodeId,
  params,
  resting,
  onTouchUp,
}: {
  nodeId: string;
  params: EditParams;
  resting: boolean;
  /** Opens the Touch up window; without it there's no Fix spots by hand row. */
  onTouchUp?: () => void;
}) {
  const setParams = useSetParams(nodeId);
  const { commit, busy } = useKeepRestCommit(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const sketch = params.mode === "sketch";
  const keep = sketch ? !!params.sketchKeepOriginal : params.keepOriginal;
  // Free right now: up to date with its settings and what it reads.
  const free = useCanvas((s) =>
    canReblend(s.doc, nodeId, s.fingerprints[nodeId], analysis?.inputsChanged ?? false),
  );
  const first = useCanvas((s) => (free ? (s.doc.results[nodeId]?.assetIds[0] ?? null) : null));
  const state = useKeepRestState(first).data;
  // An image edited without a mask or marks has no rest to keep: the settings wait for the next Run.
  const ran = free && !!state && state.unavailable !== "not_an_edit";
  // Turned off after a run: it shows the model's own result, saved as an image of its own.
  const own = ran && state.unavailable === "saved_result";
  // An edit older than the kept result can't be adjusted: its settings rest as they were.
  const old = ran && !state.available && !own;
  const fellBack = ran && state.available && state.keep && state.fellBack !== null;
  const settled = resting || busy || old;

  const [draft, setDraft] = useState<{ key: SliderKey; value: number } | null>(null);
  const shownValue = (key: SliderKey) => (draft?.key === key ? draft.value : sliderValue(params, key));
  const change = (key: SliderKey, value: number) => {
    if (ran) setDraft({ key, value });
    else setParams({ [key]: value }, key);
  };
  const release = (key: SliderKey, value: number) => {
    if (!ran) return;
    void commit({ [key]: value }, key).finally(() => setDraft(null));
  };
  const toggle = (on: boolean) => {
    void commit(sketch ? { sketchKeepOriginal: on } : { keepOriginal: on }, "keepOriginal");
  };

  const slider = (key: SliderKey, label: string, hint: string, opts: { dim: boolean }) => {
    const value = shownValue(key);
    return (
      <Field
        label={label}
        description={hint}
        className={cn("px-2 py-4", opts.dim && "opacity-40")}
        data-keep-rest={key}
      >
        <SliderRow
          value={[value]}
          min={key === "sensitivity" ? KEEP_REST_SENSITIVITY.min : 0}
          max={key === "sensitivity" ? KEEP_REST_SENSITIVITY.max : MASK_COMPOSITE_MAX_PX}
          step={1}
          disabled={opts.dim || settled}
          onValueChange={([next]) => next !== undefined && change(key, next)}
          onValueCommit={([next]) => next !== undefined && release(key, next)}
          valueLabel={t(
            key === "sensitivity" ? "canvas.nodes.edit.keepRest.percent" : "canvas.nodes.edit.keepRest.px",
            {
              value,
            },
          )}
          // The field dims as a whole; the slider doesn't dim twice.
          className="data-disabled:opacity-100"
        />
      </Field>
    );
  };

  return (
    // Keep the rest: column gap 4. Locked or read-only, it rests as a whole.
    <div
      inert={resting}
      aria-busy={busy || undefined}
      data-keep-rest-block={ran ? "after" : "before"}
      className={cn("flex w-full shrink-0 flex-col gap-4", resting && "opacity-45")}
    >
      {/* Keep the rest: row gap 16 pad 4 2, space between, centred. */}
      <Field
        layout="inline"
        label={t("canvas.nodes.edit.keepRest.label")}
        description={t(
          sketch
            ? keep
              ? "canvas.nodes.edit.keepRest.sketchOn"
              : "canvas.nodes.edit.keepRest.sketchOff"
            : keep
              ? "canvas.nodes.edit.keepRest.on"
              : own
                ? "canvas.nodes.edit.keepRest.offAfterRun"
                : "canvas.nodes.edit.keepRest.off",
        )}
        className={cn("px-2 py-4", old && "opacity-40")}
      >
        <Switch checked={keep} disabled={settled} onCheckedChange={toggle} />
      </Field>
      {old ? (
        <Line
          icon={Info}
          text={
            state.unavailable === "not_stored" || !state.note
              ? t("canvas.nodes.edit.keepRest.notStored")
              : state.note
          }
        />
      ) : null}
      {fellBack ? <Line icon={Info} text={maskOnlyNote(state)} /> : null}
      {sketch && !keep
        ? null
        : slider(
            "sensitivity",
            t("canvas.nodes.edit.keepRest.sensitivity"),
            t("canvas.nodes.edit.keepRest.sensitivityHint"),
            {
              // Only the mask decided, or it's off: Sensitivity has nothing to say.
              dim: !keep || fellBack || old || params.keepRestMode === "mask",
            },
          )}
      {sketch ? null : (
        <>
          {slider(
            "featherPx",
            t("canvas.nodes.edit.keepRest.feather"),
            t("canvas.nodes.edit.keepRest.featherHint"),
            {
              dim: !keep || old,
            },
          )}
          {slider(
            "expandPx",
            t("canvas.nodes.edit.keepRest.expand"),
            t("canvas.nodes.edit.keepRest.expandHint"),
            {
              dim: !keep || old,
            },
          )}
        </>
      )}
      {ran && !old && !own && onTouchUp ? (
        // Fix spots by hand: row gap 16 pad 4 2, space between, centred.
        <div className="flex w-full items-center justify-between gap-16 px-2 py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-small font-medium text-text-primary">
              {t("canvas.nodes.edit.keepRest.fixLabel")}
            </span>
            <span className="w-full text-caption text-text-tertiary">
              {t("canvas.nodes.edit.keepRest.fixHint")}
            </span>
          </div>
          <Button variant="secondary" size="s" icon={Paintbrush} disabled={settled} onClick={onTouchUp}>
            {t("canvas.nodes.edit.keepRest.touchUp")}
          </Button>
        </div>
      ) : null}
      {ran && !old ? <Line icon={Zap} text={t("canvas.nodes.edit.keepRest.free")} /> : null}
    </div>
  );
}

type SliderKey = "sensitivity" | "featherPx" | "expandPx";

const sliderValue = (p: EditParams, key: SliderKey): number =>
  key === "sensitivity" ? (p.sensitivity ?? KEEP_REST_SENSITIVITY.default) : p[key];

/** The mask alone decided: the design's words when the result didn't line up, else the server's. */
const maskOnlyNote = (state: KeepRestState) =>
  state.fellBack === "no_match"
    ? t("canvas.nodes.edit.keepRest.maskOnly")
    : (state.note ?? t("canvas.nodes.edit.keepRest.maskOnly"));

/** Note and Hint: row gap 8 pad 0 2, centred; a 14 px icon and 12 px words, both secondary. */
function Line({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex w-full items-center gap-8 px-2">
      <Icon size={14} aria-hidden className="shrink-0 text-text-secondary" />
      <span className={cn("min-w-0 flex-1", NOTE)}>{text}</span>
    </div>
  );
}
