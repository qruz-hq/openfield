import type { EngineContext } from "@openfield/canvas/engine/types";
import { type ModelListItem, t } from "@openfield/core";
import { useProviders } from "../../../api/hooks/keys";
import { speedFallbackHint } from "../../../lib/cost";
import { companyName } from "../../../lib/provider";
import { useCanvasEngineContext } from "../../engine/engine-store";

// What a node's price says about its company's speed (§0.3), in the composer's words: nothing at
// Standard, the speed in the tooltip otherwise, and "Standard for this model" when the model lacks
// its company's speed and runs at Standard instead.

export interface NodeSpeed {
  /** The speed it falls back to ("Standard"), when a model lacks its company's. */
  fallback?: string;
  /** One line per model for the tooltip. */
  tips: string[];
}

export function nodeSpeed(
  ctx: EngineContext,
  models: readonly (ModelListItem | undefined)[],
  company: (providerId: string) => string,
): NodeSpeed | undefined {
  const tips = new Set<string>();
  let fallback: string | undefined;
  for (const model of models) {
    const run = model && ctx.runSpeed?.(model);
    if (!model || !run) continue;
    if (run.fellBack) {
      fallback ??= run.name;
      tips.add(speedFallbackHint(model, run));
    } else if (run.speed !== "standard") {
      tips.add(t("speed.tooltip", { speed: run.name, company: company(model.providerId) }));
    }
  }
  return tips.size ? { ...(fallback && { fallback }), tips: [...tips] } : undefined;
}

export function useNodeSpeed(models: readonly (ModelListItem | undefined)[]): NodeSpeed | undefined {
  const ctx = useCanvasEngineContext();
  const providers = useProviders().data;
  return nodeSpeed(ctx, models, (providerId) => companyName(providers, providerId));
}
