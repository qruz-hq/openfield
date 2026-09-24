import { t } from "@openfield/core";
import { BrandMark, cn, ModelCaption } from "@openfield/ui";
import { memo, useMemo } from "react";
import { ModelSelect } from "../../../image/composer/model-select";
import { logoFor } from "../../../lib/provider";
import { EMPTY_ENGINE_CONTEXT, speedOf } from "../../engine/context-base";
import { useNodeAnalysis } from "../../engine/engine-store";
import { modelKeyOf, modelsFitting } from "../../engine/inputs";
import { useNodeResult, useNodeRuntime, useReadOnly } from "../../store/context";
import type { NodeComponentProps } from "../registry";
import { CollapsedStatus } from "../shell/collapsed-card";
import { leaveField } from "../shell/focus";
import { NodeShell } from "../shell/node-shell";
import { ResultGrid } from "../shell/results";
import { RunPill } from "../shell/run-pill";
import { StateBand } from "../shell/state-band";
import { PartialImage } from "../shell/thumb";
import { useNodeBasics, useNodeDisplay, useParsedParams, useSetParams } from "../shell/use-node";
import { SizeBadge, sizeControls, useModelSwitch } from "./controls";
import { type GenerateParams, generateSpec } from "./spec";

// Canvas / Node / Generate (design Y5jjx, 320×400): the preview on $surface with the size badges
// and the state band at its foot, then the footer: the prompt line, the model chip (the composer's
// own ModelSelect) and the run pill.

const FOOTER = 90;

export const GenerateNode = memo(function GenerateNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const ctx = basics?.ctx ?? EMPTY_ENGINE_CONTEXT;
  const params = useParsedParams<GenerateParams>(id, generateSpec, ctx);
  const setParams = useSetParams(id);
  const switchModel = useModelSwitch(id);
  const result = useNodeResult(id);
  const runtime = useNodeRuntime(id);
  const analysis = useNodeAnalysis(id);
  const display = useNodeDisplay(id);
  const readOnly = useReadOnly();
  const key = modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const speed = model ? speedOf(ctx, model) : "standard";
  const controls = useMemo(() => sizeControls(model, params, 1, speed), [model, params, speed]);

  if (!basics) return null;
  const { frame } = basics;
  const name = frame.title?.trim() || t(generateSpec.label);
  const images = result?.assetIds ?? [];
  const previewHeight = Math.max(80, (props.height ?? generateSpec.size!.h) - FOOTER);
  const upstream = analysis?.upstreamText ?? "";
  const logo = logoFor(model?.providerId);
  const noRefs =
    model && !model.capabilities.references.supported ? t("canvas.nodes.ports.noReferences") : null;
  const partial = display.state === "running" ? runtime?.partialThumbUrl : null;

  return (
    <NodeShell
      {...props}
      spec={generateSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      changed={display.state === "stale"}
      fanOut={display.fanOut}
      portOff={{ input_images: noRefs }}
      inspectable
      collapsedMeta={
        logo ? (
          <ModelCaption provider={logo} name={model?.displayName ?? key ?? ""} />
        ) : (
          <span className="truncate text-micro font-medium text-text-primary">
            {model?.displayName ?? key}
          </span>
        )
      }
      collapsedStatus={<CollapsedStatus display={display} />}
      thumbs={images}
    >
      <div className="relative flex min-h-0 flex-1 flex-col justify-end bg-surface">
        {partial ? (
          <div className="absolute inset-0">
            <PartialImage path={partial} />
          </div>
        ) : images.length ? (
          <ResultGrid
            assetIds={images}
            height={previewHeight}
            dim={display.state === "stale"}
            className="absolute inset-0"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <BrandMark size={24} className="opacity-30" />
          </div>
        )}
        {images.length && controls.length ? (
          <div className="relative flex w-full gap-4 px-10 pb-10">
            {controls.map((control) => (
              <SizeBadge
                key={control.id}
                control={control}
                disabled={readOnly}
                onChange={(patch) => setParams(patch)}
              />
            ))}
          </div>
        ) : null}
        <div className="relative w-full">
          <StateBand id={id} display={display} model={key} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-10 p-12">
        <input
          value={params.prompt}
          readOnly={readOnly}
          placeholder={upstream || t("canvas.nodes.generate.promptPlaceholder")}
          aria-label={t("canvas.nodes.generate.promptField")}
          onChange={(event) => setParams({ prompt: event.target.value }, "prompt")}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" || event.key === "Enter") leaveField(event.currentTarget);
          }}
          className={cn(
            "nodrag w-full min-w-0 truncate bg-transparent text-small text-text-secondary outline-none",
            upstream ? "placeholder:text-text-secondary" : "placeholder:text-text-tertiary",
          )}
        />
        <div className="flex w-full items-center justify-between gap-8">
          <div className="nodrag min-w-0">
            <ModelSelect
              models={modelsFitting(ctx.models, { references: analysis?.references ?? 0 }, key)}
              selected={model}
              onSelect={(next) => {
                if (!readOnly && next.key !== model?.key) switchModel(model, next, params);
              }}
            />
          </div>
          <RunPill
            id={id}
            name={name}
            estimate={analysis?.estimate ?? null}
            blocker={display.blocker}
            upToDate={analysis?.upToDate ?? false}
            seedless={!model?.capabilities.seed.supported}
            models={[model]}
          />
        </div>
      </div>
    </NodeShell>
  );
});
