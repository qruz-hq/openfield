import { type CostEstimate, DEFAULT_CURRENCY, type EstimateBody, type ModelListItem } from "@openfield/core";

// Prices a company answers per request (price.kind "provider_estimate", §6.9), such as
// Higgsfield's. The answer comes from outside this package: the web app asks the server
// (lib/remote-price.ts), which keeps each answer for a day. estimateRun takes whatever asks.

/** What decides the price: the estimate route's body. The prompt never does, so it's left out. */
export type PriceAsk = Omit<EstimateBody, "prompt">;

/** Answers at once, from what it has: the price, or PENDING_PRICE while it's being asked. */
export type AskPrice = (model: ModelListItem, ask: PriceAsk) => CostEstimate;

export const asksForPrice = (model: Pick<ModelListItem, "price">): boolean =>
  model.price.kind === "provider_estimate";

/**
 * A price still being asked. Shown as no price at all, never as "Cost unknown", so a price that's
 * a moment away doesn't flash a wrong answer. Kept as data (an unknown with no basis) so it
 * survives the copies canvas totals make.
 */
export const PENDING_PRICE: CostEstimate = {
  currency: DEFAULT_CURRENCY,
  min: 0,
  max: 0,
  confidence: "unknown",
  basis: "",
  pricedAt: "",
};

export const isPricePending = (estimate: CostEstimate | undefined): boolean =>
  estimate !== undefined && estimate.confidence === "unknown" && estimate.basis === "";
