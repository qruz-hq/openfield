import type { PriceModel } from "@openfield/core";

// Higgsfield prices each request in credits, which depend on the model and its settings, and
// publishes only "from" prices per model. The exact figure comes from its estimate endpoint
// (POST /estimate/<model path>, answering {"credits": "1.500", "usd": "0.094"}), which
// estimateRemote() calls. Until a caller uses it, the composer says "Cost unknown" (README.md).
export const PRICE: PriceModel = {
  kind: "provider_estimate",
  currency: "USD",
  pricedAt: "2026-09-27",
  sourceUrl: "https://open.higgsfield.ai/pricing?tab=images",
};
