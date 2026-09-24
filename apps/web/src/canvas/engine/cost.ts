import { type CostEstimate, DEFAULT_CURRENCY } from "@openfield/core";
import { scaleCostEstimate, sumCostEstimates } from "@openfield/core/canvas";

// Adding up estimates (§0.13) with core's rule, the one the server's run response uses, so the
// browser and the server agree on totals. Unknown prices never count as zero: a sum of only
// unknowns is unknown, and a sum with some unknowns covers the known part (the caller names the rest).

export const ZERO_COST: CostEstimate = {
  currency: DEFAULT_CURRENCY,
  min: 0,
  max: 0,
  confidence: "exact",
  basis: "",
  pricedAt: "",
};

export const UNKNOWN_COST: CostEstimate = { ...ZERO_COST, confidence: "unknown" };

/** k runs of the same thing, as fan-out does. */
export const scaleEstimate = (estimate: CostEstimate, k: number): CostEstimate =>
  scaleCostEstimate(estimate, k);

/** The known estimates added up. Unknown when nothing is known and there was something to price. */
export const sumEstimates = (estimates: readonly CostEstimate[]): CostEstimate =>
  estimates.length ? sumCostEstimates(estimates) : ZERO_COST;

/**
 * To the cent, the way the rows show it, so rows always add up to the total under them. A cost
 * under a cent shows as one cent rather than as free.
 */
export function roundToCents(estimate: CostEstimate): CostEstimate {
  if (estimate.confidence === "unknown") return estimate;
  const cents = (usd: number) => (usd > 0 ? Math.max(1, Math.round(usd * 100)) / 100 : 0);
  return { ...estimate, min: cents(estimate.min), max: cents(estimate.max) };
}
