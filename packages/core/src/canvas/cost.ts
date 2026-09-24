import { DEFAULT_CURRENCY } from "../constants";
import type { CostEstimate } from "../schemas/cost";

// Adding estimates up for a node with several calls, or a whole run (§7.7 cost preview). The
// server's run response and the browser's preview use the same rule, so their totals agree.

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** Nothing to pay for: shown as "Free". */
export const freeEstimate = (): CostEstimate => ({
  currency: DEFAULT_CURRENCY,
  min: 0,
  max: 0,
  confidence: "exact",
  basis: "",
  pricedAt: "",
});

/**
 * Sums the priced estimates. Unknown ones are left out of the amounts (the preview names them
 * separately); the total is unknown only when nothing in it is priced.
 */
export function sumCostEstimates(estimates: readonly CostEstimate[]): CostEstimate {
  if (estimates.length === 0) return freeEstimate();
  const known = estimates.filter((e) => e.confidence !== "unknown");
  if (known.length === 0) {
    return { ...estimates[0]!, min: 0, max: 0, basis: estimates[0]!.basis };
  }
  const exact = known.length === estimates.length && known.every((e) => e.confidence === "exact");
  const dates = known.map((e) => e.pricedAt).filter(Boolean);
  return {
    currency: known[0]!.currency,
    min: round(known.reduce((sum, e) => sum + e.min, 0)),
    max: round(known.reduce((sum, e) => sum + e.max, 0)),
    confidence: exact ? "exact" : "estimated",
    basis: known
      .map((e) => e.basis)
      .filter(Boolean)
      .join(" + "),
    // The oldest price in the sum is the one most likely to have moved.
    pricedAt: dates.sort()[0] ?? "",
  };
}

/** An estimate for `times` identical runs, as a fanned-out node makes. */
export function scaleCostEstimate(estimate: CostEstimate, times: number): CostEstimate {
  if (times === 1) return estimate;
  return {
    ...estimate,
    min: round(estimate.min * times),
    max: round(estimate.max * times),
    basis: estimate.basis && times > 1 ? `${times} × (${estimate.basis})` : estimate.basis,
  };
}
