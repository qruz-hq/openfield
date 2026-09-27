import { type CostEstimate, DEFAULT_CURRENCY, formatMoney, type PriceModel, t } from "@openfield/core";
import { ProviderError } from "../types";

// Higgsfield prices each request in credits, which depend on the model and its settings, and
// publishes only "from" prices per model. The exact figure comes from its estimate endpoint
// (POST /estimate/<model path>), which estimateRemote() calls and the server caches (§6.9).
export const PRICE: PriceModel = {
  kind: "provider_estimate",
  currency: "USD",
  pricedAt: "2026-09-27",
  sourceUrl: "https://open.higgsfield.ai/pricing?tab=images",
};

/**
 * What the estimate endpoint answers, checked live on 2026-09-27. Most workflows answer
 * {"type": "estimate", "credits": "0.050", "usd": "0.004", "discount": null}. The token-priced
 * ones (Marketing Studio 2.5) answer {"type": "description", "pricing_description": "Per 1M
 * tokens: ..."} with no amount, since they're billed on the tokens used.
 */
export interface EstimateAnswer {
  type?: string;
  credits?: string;
  usd?: string;
  discount?: unknown;
  pricing_description?: string;
}

/** One request's answer as the cost of `count` images. Every call makes one image (README.md). */
export function toCostEstimate(body: unknown, count: number, now: number): CostEstimate {
  const answer = (body ?? {}) as EstimateAnswer;
  const pricedAt = new Date(now).toISOString().slice(0, 10);
  if (answer.type === "description") {
    return {
      currency: DEFAULT_CURRENCY,
      min: 0,
      max: 0,
      confidence: "unknown",
      basis: t("cost.unknown"),
      pricedAt,
    };
  }
  const each = Number(answer.usd);
  if (typeof answer.usd !== "string" || !Number.isFinite(each) || each < 0) {
    throw new ProviderError("provider_error", { message: "The estimate had no dollar amount" });
  }
  const credits = Number(answer.credits);
  const money = formatMoney(each, DEFAULT_CURRENCY, true);
  const total = Math.round(each * count * 1e6) / 1e6;
  return {
    currency: DEFAULT_CURRENCY,
    min: total,
    max: total,
    confidence: "estimated",
    // Credits are Higgsfield's own unit, so they go in the note, never in the price itself.
    basis: Number.isFinite(credits)
      ? t("cost.basisWith", { count, each: money, detail: t("cost.credits", { credits }) })
      : t("cost.basis", { count, each: money }),
    pricedAt,
  };
}
