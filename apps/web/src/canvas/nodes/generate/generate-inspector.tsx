import { speedOf } from "@openfield/canvas/engine/context-base";
import { modelKeyOf, modelsFitting } from "@openfield/canvas/engine/inputs";
import { type GenerateParams, generateSpec } from "@openfield/canvas/nodes/generate/spec";
import { type ModelListItem, t } from "@openfield/core";
import { clampBatch } from "@openfield/providers/manifest";
import { Badge, Button, cn, Divider, Stepper } from "@openfield/ui";
import { ChevronDown, SlidersHorizontal, Timer } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useLocked, useNodeFrame, useReadOnly } from "../../store/context";
import { InspectorRun, LOCKED_DIM, ModelField, SizeField } from "../shell/inspector-parts";
import { PromptCard } from "../shell/prompt-card";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";
import { sizeControls, useModelSwitch } from "./controls";
import { SeedField } from "./seed-field";

// Generate's settings (design AWQzm): the prompt card (add a reference, the whole prompt coming in
// from a Prompt node, the node's own words), the model and its speed note, the size fields
// (resolution or quality, and aspect ratio), how many images, the Advanced row (the seed, and
// later each model's extras), then Run. Everything the card doesn't show is set here. While the
// node is locked (design L79Zt) each of those is read-only at 45%, and Run waits at 35%.

export function GenerateInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const frame = useNodeFrame(nodeId);
  const params = useParsedParams<GenerateParams>(nodeId, generateSpec, ctx);
  const setParams = useSetParams(nodeId);
  const switchModel = useModelSwitch(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const readOnly = useReadOnly();
  const locked = useLocked(nodeId);
  const dim = locked ? LOCKED_DIM : undefined;
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const speed = model ? speedOf(ctx, model) : "standard";
  const controls = useMemo(() => sizeControls(model, params, 1, speed), [model, params, speed]);
  const busy = display.state === "queued" || display.state === "running";

  if (!frame) return null;
  return (
    <>
      <PromptCard
        nodeId={nodeId}
        value={params.prompt}
        onChange={(prompt) => setParams({ prompt }, "prompt")}
        references={!!model?.capabilities.references.supported}
        placeholder={t("canvas.nodes.generate.promptPlaceholder")}
        fieldLabel={t("canvas.nodes.generate.promptField")}
        fromLabel={t("canvas.nodes.generate.fromPrompt")}
      />
      <ModelField
        models={modelsFitting(ctx.models, { references: analysis?.references ?? 0 }, key)}
        selected={model}
        disabled={readOnly}
        locked={locked}
        onSelect={(next) => {
          if (next.key !== model?.key) switchModel(model, next, params);
        }}
      />
      <SpeedNote model={model} />
      {controls.length ? (
        // Size row (HuDXy): resolution or quality, then aspect ratio, sharing the width.
        <div className={cn("flex w-full gap-8", dim)}>
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
      <div className={cn("flex w-full items-center justify-between px-2", dim)}>
        <span className="text-small font-medium text-text-primary">{t("canvas.nodes.inspector.images")}</span>
        <Stepper
          value={model ? clampBatch(model.capabilities, params.batch) : params.batch}
          min={1}
          max={model?.capabilities.batch.max ?? 4}
          disabled={readOnly}
          readOnly={locked}
          onValueChange={(batch) => setParams({ batch }, "batch")}
          decrementLabel={t("canvas.nodes.inspector.fewer")}
          incrementLabel={t("canvas.nodes.inspector.more")}
          aria-label={t("canvas.nodes.inspector.images")}
        />
      </div>
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

const SPEED_NOTES = {
  batch: "canvas.nodes.inspector.speedNote.batch",
  flex: "canvas.nodes.inspector.speedNote.flex",
  priority: "canvas.nodes.inspector.speedNote.priority",
} as const;

/**
 * Speed note (design WNHOX): under the model when its company runs it at a speed other than
 * Standard, with a way to that company's settings.
 */
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
      <Button
        variant="link"
        size="s"
        onClick={() => navigate("/settings/api-keys", { state: { providerSettings: model.providerId } })}
      >
        {t("canvas.nodes.inspector.changeSpeed")}
      </Button>
    </div>
  );
}

/** Advanced (design iWF7C): a 32-tall row that opens what's inside, with how many differ from the default. */
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
