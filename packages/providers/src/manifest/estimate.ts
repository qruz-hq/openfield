import {
  type CostEstimate,
  DEFAULT_CURRENCY,
  formatMoney,
  type ModelManifest,
  type NormalizedRequest,
  type PerImagePrice,
  type PriceModel,
  type SpeedId,
  t,
} from "@openfield/core";
import { pricedOp, priceFor, resolveSpeed } from "./speed";

// §0.13: pure. Reads the manifest's prices and the request, never credentials, the network or the
// clock, so the composer can re-run it on every chip change.

/**
 * The fields a price depends on. A full NormalizedRequest fits, and so does the composer's state.
 * `speed` is what the company's settings resolve to; a speed the model lacks prices as Standard.
 */
export type EstimateRequest = Pick<NormalizedRequest, "batch"> &
  Partial<
    Pick<NormalizedRequest, "resolution" | "quality" | "size" | "prompt" | "promptAfterPreset" | "op">
  > & { speed?: SpeedId };

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

function unknownCost(pricedAt = ""): CostEstimate {
  return {
    currency: DEFAULT_CURRENCY,
    min: 0,
    max: 0,
    confidence: "unknown",
    basis: t("cost.unknown"),
    pricedAt,
  };
}

export function estimate(manifest: ModelManifest, req: EstimateRequest): CostEstimate {
  const { speed } = resolveSpeed(manifest, req.speed ?? "standard", pricedOp(req.op));
  const price = priceFor(manifest, speed);
  const count = Math.max(1, req.batch);
  // The basis names the speed whenever it isn't Standard: "2 × $0.067 (1K, Batch)".
  const speedLabel = speed === "standard" ? undefined : t(`speed.names.${speed}`);
  switch (price.kind) {
    case "per_image":
      return perImage(manifest, price, req, count, speedLabel);
    case "per_token":
      return perToken(manifest, price, req, count, speedLabel);
    case "per_second":
    case "provider_estimate":
      // Images have no duration, and a remote estimate needs estimateRemote().
      return unknownCost(price.pricedAt);
    case "unknown":
      return unknownCost();
  }
}

type PerImagePriceModel = Extract<PriceModel, { kind: "per_image" }>;
type PerTokenPriceModel = Extract<PriceModel, { kind: "per_token" }>;

function perImage(
  manifest: ModelManifest,
  price: PerImagePriceModel,
  req: EstimateRequest,
  count: number,
  speedLabel: string | undefined,
): CostEstimate {
  const caps = manifest.capabilities;
  const tier = req.resolution ?? caps.resolution?.default;
  const quality = req.quality ?? caps.quality?.default;

  const specificity = (p: PerImagePrice) => (p.tier ? 1 : 0) + (p.quality ? 1 : 0);
  const hit = price.tiers
    .filter((p) => (!p.tier || p.tier === tier) && (!p.quality || p.quality === quality))
    .sort((a, b) => specificity(b) - specificity(a))[0];

  if (hit) {
    const label = [hit.quality && qualityLabel(manifest, hit.quality), hit.tier, speedLabel]
      .filter(Boolean)
      .join(", ");
    return {
      currency: price.currency,
      min: round(hit.usd * count),
      max: round(hit.usd * count),
      confidence: "exact",
      basis: label
        ? t("cost.basisWith", { count, each: formatMoney(hit.usd, price.currency, true), detail: label })
        : t("cost.basis", { count, each: formatMoney(hit.usd, price.currency, true) }),
      pricedAt: price.pricedAt,
    };
  }

  // No row for this combination: show the whole range rather than guess one row.
  const amounts = price.tiers.map((p) => p.usd);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  return {
    currency: price.currency,
    min: round(low * count),
    max: round(high * count),
    confidence: "estimated",
    basis: basis(count, moneyRange(low, high, price.currency), speedLabel),
    pricedAt: price.pricedAt,
  };
}

function perToken(
  manifest: ModelManifest,
  price: PerTokenPriceModel,
  req: EstimateRequest,
  count: number,
  speedLabel: string | undefined,
): CostEstimate {
  const caps = manifest.capabilities;
  const quality = req.quality ?? caps.quality?.default;
  const tier = req.resolution ?? caps.resolution?.default;
  const sizeKey = req.size && "width" in req.size ? `${req.size.width}x${req.size.height}` : undefined;

  const rows = price.outputTokenTable.filter((r) => !quality || r.quality === quality);
  const exact = rows.find((r) => r.size === sizeKey) ?? rows.find((r) => r.size === tier);
  const candidates = exact ? [exact] : rows.length ? rows : price.outputTokenTable;
  if (!candidates.length) return unknownCost(price.pricedAt);

  const tokens = candidates.map((r) => r.tokens);
  const outLow = (Math.min(...tokens) * price.imageOutputPerMTok) / 1e6;
  const outHigh = (Math.max(...tokens) * price.imageOutputPerMTok) / 1e6;
  // Roughly four characters per token; input text is a small share of the total.
  const text = req.promptAfterPreset ?? req.prompt ?? "";
  const textIn = (Math.ceil(text.length / 4) * price.textInputPerMTok) / 1e6;

  const low = outLow + textIn;
  const high = outHigh + textIn;
  return {
    currency: price.currency,
    min: round(low * count),
    max: round(high * count),
    confidence: "estimated",
    basis: basis(count, moneyRange(low, high, price.currency), speedLabel),
    pricedAt: price.pricedAt,
  };
}

function basis(count: number, each: string, detail: string | undefined): string {
  return detail ? t("cost.basisWith", { count, each, detail }) : t("cost.basis", { count, each });
}

/** "$0.134", or "$0.039–$0.134" per image. */
function moneyRange(low: number, high: number, currency: string): string {
  const min = formatMoney(low, currency, true);
  return low === high ? min : t("cost.range", { min, max: formatMoney(high, currency, true) });
}

function qualityLabel(manifest: ModelManifest, id: string): string {
  return manifest.capabilities.quality?.levels.find((l) => l.id === id)?.label ?? id;
}
