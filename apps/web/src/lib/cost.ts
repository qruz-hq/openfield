import { type CostEstimate, formatCost, type ModelListItem } from "@openfield/core";
import { estimateRun, resolveValues } from "./controls";

/** "~$0.04" for chips and option rows, or nothing when the price isn't known. */
export function tightCost(estimate: CostEstimate): string | undefined {
  return estimate.confidence === "unknown" ? undefined : formatCost(estimate, { tight: true });
}

/** One image at the model's own defaults, for the model picker and the key card's tags. */
export const defaultPrice = (model: ModelListItem): string | undefined =>
  tightCost(estimateRun(model, resolveValues(model.capabilities, {}, 1), ""));
