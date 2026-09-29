import { type VideoParams, videoModelKeyOf, videoSpec } from "@openfield/canvas/nodes/video/spec";
import { type ModelListItem, t } from "@openfield/core";
import { Badge, cn, Divider, Switch } from "@openfield/ui";
import { ChevronDown, SlidersHorizontal, Timer } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useNavigate } from "react-router";
import { notify } from "../../../lib/notify";
import { carryVideoValues } from "../../../video/composer/video-values";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useCanvasStoreApi, useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { SeedField } from "../generate/seed-field";
import { InspectorRun, LOCKED_DIM, ModelField, SizeField } from "../shell/inspector-parts";
import { LinkedPrompt } from "../shell/linked-text";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";
import { videoControls } from "./controls";

// Video's settings (design AWQzm, mirroring GenerateInspector): the prompt card, the model and its
// speed note, Aspect / Resolution / Length, Sound and Still camera, Advanced (Seed), then Run.
// Frames come in only through the card's ports, so there's no add-frame control here.

export function VideoInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const store = useCanvasStoreApi();
  const frame = useNodeFrame(nodeId);
  const params = useParsedParams<VideoParams>(nodeId, videoSpec, ctx);
  const setParams = useSetParams(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const dim = locked ? LOCKED_DIM : undefined;
  const key = videoModelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const caps = model?.capabilities.video;
  const upstream = analysis?.upstreamText ?? "";
  const busy = display.state === "queued" || display.state === "running";
  const controls = videoControls(model, params);
  const videoModels = ctx.models.filter((m) => m.modality === "video");

  const switchModel = (next: ModelListItem) => {
    const asked =
      params.size?.kind === "aspect" ? params.size.ratio : params.size?.kind === "auto" ? "auto" : undefined;
    const before = {
      model: params.model,
      size: params.size,
      resolution: params.resolution,
      seconds: params.seconds,
      sound: params.sound,
    };
    const carried = carryVideoValues(next, {
      aspect: asked,
      resolution: params.resolution,
      seconds: params.seconds,
      sound: params.sound,
    });
    const patch: Partial<VideoParams> = {
      model: next.key,
      ...(carried.values.aspect && {
        size:
          carried.values.aspect === "auto"
            ? { kind: "auto" }
            : { kind: "aspect", ratio: carried.values.aspect },
      }),
      resolution: carried.values.resolution,
      seconds: carried.values.seconds,
      sound: carried.values.sound,
    };
    store.getState().actions.apply([{ op: "setParams", id: nodeId, patch }], { label: "model" });
    if (carried.adjusted.length) {
      const changes = carried.adjusted
        .map((a) => t("composer.change", { from: a.from, to: a.to }))
        .join(", ");
      notify(t("composer.adjusted", { count: carried.adjusted.length, model: next.displayName, changes }), {
        duration: 8000,
        action: {
          label: t("actions.undo"),
          onClick: () => store.getState().actions.apply([{ op: "setParams", id: nodeId, patch: before }]),
        },
      });
    }
  };

  if (!frame) return null;
  return (
    <>
      <div className={cn("flex w-full flex-col gap-12 rounded-14 bg-surface p-12", dim)}>
        {upstream ? (
          <p className="w-full text-small leading-[1.5] break-words whitespace-pre-wrap text-text-primary">
            <LinkedPrompt parts={analysis?.upstreamParts ?? []} own="" />
          </p>
        ) : null}
        <textarea
          value={params.prompt}
          readOnly={readOnly || locked}
          rows={2}
          placeholder={locked ? undefined : t("canvas.nodes.video.promptPlaceholder")}
          aria-label={t("canvas.nodes.video.promptField")}
          onChange={(event) => setParams({ prompt: event.target.value }, "prompt")}
          onKeyDown={(event) => event.stopPropagation()}
          className="field-sizing-content max-h-200 min-h-20 w-full resize-none bg-transparent text-small leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </div>
      <ModelField
        models={videoModels}
        selected={model}
        disabled={readOnly}
        locked={locked}
        onSelect={(next) => {
          if (next.key !== model?.key) switchModel(next);
        }}
      />
      <SpeedNote model={model} />
      {controls.length ? (
        <div className={cn("flex w-full flex-wrap gap-8", dim)}>
          {controls.map((control) => (
            <SizeField
              key={control.id}
              control={control}
              disabled={readOnly}
              locked={locked}
              onPick={(value) => setParams(control.patch(value))}
            />
          ))}
        </div>
      ) : null}
      {caps?.audio.supported ? (
        <ToggleRow
          label={t("video.chips.sound.label")}
          checked={params.sound ?? caps.audio.default}
          disabled={readOnly}
          locked={locked}
          onCheckedChange={(sound) => setParams({ sound })}
        />
      ) : null}
      {caps?.cameraFixed ? (
        <ToggleRow
          label={t("video.chips.cameraFixed.label")}
          hint={t("video.chips.cameraFixed.hint")}
          checked={params.cameraFixed}
          disabled={readOnly}
          locked={locked}
          onCheckedChange={(cameraFixed) => setParams({ cameraFixed }, "cameraFixed")}
        />
      ) : null}
      <Divider />
      <Advanced changed={params.seed.mode === "fixed" ? 1 : 0} className={dim}>
        <SeedField
          model={model}
          seed={params.seed}
          disabled={readOnly || locked}
          onChange={(seed) => setParams({ seed }, "seed")}
        />
      </Advanced>
      <InspectorRun
        estimate={analysis?.estimate ?? null}
        models={[model]}
        disabled={readOnly || busy}
        locked={locked}
        onRun={(anchor, bypassCache) => void run("node", { anchor, bypassCache })}
      />
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  locked,
  onCheckedChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  locked?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex w-full items-center justify-between gap-8 px-2 py-4">
      <label htmlFor={id} className="flex flex-col gap-2">
        <span className="text-small font-medium text-text-primary">{label}</span>
        {hint ? <span className="text-caption text-text-tertiary">{hint}</span> : null}
      </label>
      <Switch id={id} checked={checked} disabled={disabled || locked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

const SPEED_NOTES = {
  batch: "canvas.nodes.inspector.speedNote.batch",
  flex: "canvas.nodes.inspector.speedNote.flex",
  priority: "canvas.nodes.inspector.speedNote.priority",
} as const;

function SpeedNote({ model }: { model: ModelListItem | undefined }) {
  const ctx = useCanvasEngineContext();
  const navigate = useNavigate();
  const run = model && ctx.runSpeed?.(model);
  if (!model || !run || run.speed === "standard") return null;
  const note =
    run.speed in SPEED_NOTES
      ? t(SPEED_NOTES[run.speed as keyof typeof SPEED_NOTES])
      : t("canvas.nodes.inspector.speedNote.other", { speed: run.name });
  return (
    <div className="flex w-full items-center gap-6 px-2">
      <Timer size={12} aria-hidden className="shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 text-caption text-text-tertiary">{note}</span>
      <button
        type="button"
        className="cursor-pointer text-caption font-medium text-accent hover:underline"
        onClick={() => navigate("/settings/api-keys", { state: { providerSettings: model.providerId } })}
      >
        {t("canvas.nodes.inspector.changeSpeed")}
      </button>
    </div>
  );
}

function Advanced({
  changed,
  className,
  children,
}: {
  changed: number;
  className?: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((was) => !was)}
        className={cn("flex h-32 w-full cursor-pointer items-center gap-8 px-2 text-left", className)}
      >
        <SlidersHorizontal size={14} aria-hidden className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 text-small font-medium text-text-primary">
          {t("canvas.nodes.inspector.advanced")}
        </span>
        {changed ? (
          <Badge variant="count" aria-label={t("canvas.nodes.inspector.changed", { count: changed })}>
            {changed}
          </Badge>
        ) : null}
        <ChevronDown
          size={14}
          aria-hidden
          className={cn("shrink-0 text-text-tertiary transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div id={panel} className={cn("flex w-full flex-col gap-12", className)}>
          {children}
        </div>
      ) : null}
    </>
  );
}
