import { type CostEstimate, formatCost, type ModelListItem, type SpeedId, t } from "@openfield/core";
import { estimateRun, type RunSpeed, resolveValues } from "@openfield/providers/manifest";

/** "~$0.067" for chips, tags and option rows, or nothing when the price isn't known. */
export function tightCost(estimate: CostEstimate): string | undefined {
  return estimate.confidence === "unknown" ? undefined : formatCost(estimate, { tight: true });
}

/** One image at the model's own defaults and its company's speed, for the picker and the key card's tags. */
export const defaultPrice = (model: ModelListItem, speed: SpeedId = "standard"): string | undefined =>
  tightCost(estimateRun(model, resolveValues(model.capabilities, {}, 1), "", speed));

export interface SpeedPrice {
  price?: string | undefined;
  /** "· Standard" when the model lacks its company's speed and runs at Standard instead. */
  note?: string | undefined;
  /** Why, in one line: "Nano Banana 2 has no Flex, so it runs at Standard." */
  hint?: string | undefined;
}

/** A model's price at the speed it would run at now, saying so plainly when that's a fallback. */
export function speedPrice(model: ModelListItem, run: RunSpeed): SpeedPrice {
  const price = defaultPrice(model, run.speed);
  if (!run.fellBack) return { price };
  return {
    price,
    note: t("speed.suffix", { speed: run.name }),
    hint: speedFallbackHint(model, run),
  };
}

/** "Nano Banana 2 has no Flex, so it runs at Standard." */
export const speedFallbackHint = (model: Pick<ModelListItem, "displayName">, run: RunSpeed): string =>
  t("speed.fallbackHint", { model: model.displayName, speed: run.requestedName, standard: run.name });
