import { speedOf } from "@openfield/canvas/engine/context-base";
import { modelKeyOf, modelsFitting } from "@openfield/canvas/engine/inputs";
import { type VariationsParams, variationsSpec } from "@openfield/canvas/nodes/variations/spec";
import { useMemo } from "react";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import { useReadOnly } from "../../store/context";
import { sizeControls, useModelSwitch } from "../generate/controls";
import { InspectorRun, ModelField, SizeField } from "../shell/inspector-parts";
import { useNodeDisplay, useParsedParams, useRunNode, useSetParams } from "../shell/use-node";

// Variations' settings: the model for New takes and Prompts (Models mode picks its models on the
// node), the size fields every run shares, then Run. Each model in Models mode clamps them to what
// it offers.

export function VariationsInspector({ nodeId }: { nodeId: string }) {
  const ctx = useCanvasEngineContext();
  const params = useParsedParams<VariationsParams>(nodeId, variationsSpec, ctx);
  const setParams = useSetParams(nodeId);
  const switchModel = useModelSwitch(nodeId);
  const analysis = useNodeAnalysis(nodeId);
  const display = useNodeDisplay(nodeId);
  const run = useRunNode(nodeId);
  const readOnly = useReadOnly();
  const byModel = params.strategy === "model-list";
  // Models mode shows the first model's options; the others clamp to theirs.
  const key = byModel ? (params.models[0] ?? null) : modelKeyOf(params.model, ctx);
  const model = ctx.model(key);
  const speed = model ? speedOf(ctx, model) : "standard";
  const controls = useMemo(() => sizeControls(model, params, 1, speed), [model, params, speed]);
  const busy = display.state === "queued" || display.state === "running";

  return (
    <>
      {byModel ? null : (
        <ModelField
          models={modelsFitting(ctx.models, { references: analysis?.references ?? 0 }, key)}
          selected={model}
          disabled={readOnly}
          onSelect={(next) => {
            if (next.key !== model?.key) switchModel(model, next, params);
          }}
        />
      )}
      {controls.length ? (
        <div className="grid w-full grid-cols-2 gap-8">
          {controls.map((control) => (
            <SizeField
              key={control.id}
              control={control}
              disabled={readOnly}
              onPick={(value) => setParams(control.patch(value))}
            />
          ))}
        </div>
      ) : null}
      <InspectorRun
        estimate={analysis?.estimate ?? null}
        models={byModel ? params.models.map((k) => ctx.model(k)) : [model]}
        disabled={readOnly || busy}
        onRun={(anchor, bypassCache) => void run("node", { anchor, bypassCache })}
      />
    </>
  );
}
