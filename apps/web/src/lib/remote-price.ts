import {
  type CostEstimate,
  canonicalJson,
  formatMoney,
  type ModelListItem,
  parseModelKey,
  t,
} from "@openfield/core";
import { type AskPrice, PENDING_PRICE, type PriceAsk } from "@openfield/providers/manifest";
import { useSyncExternalStore } from "react";
import { api, call, queryClient } from "../api/client";

export { asksForPrice, isPricePending, PENDING_PRICE, type PriceAsk } from "@openfield/providers/manifest";

// Prices a company answers per request (price.kind "provider_estimate", §6.9): Higgsfield's
// estimate endpoint, asked through the server, which keeps each answer for a day. The price
// helpers are synchronous and run while rendering, so they read what's kept here and ask for what's
// missing. An answer re-renders every reader of the model list (useModels subscribes).

const ROOT = "prices";
/** The server keeps answers for a day; this only saves a round trip to it. */
const STALE_MS = 60 * 60_000;
/** A server that couldn't be reached is asked again after this. */
const RETRY_AFTER_MS = 30_000;

/** Each model's latest answer for one image, shown while a new one for other settings is asked. */
const lastEach = new Map<string, CostEstimate>();
const asking = new Set<string>();

/** The cost of `ask.batch` images of `model`, or PENDING_PRICE until its company has answered. */
export const askedPrice: AskPrice = (model, ask) => {
  const queryKey = [ROOT, model.key, canonicalJson(ask)] as const;
  const state = queryClient.getQueryState<CostEstimate>(queryKey);
  const now = Date.now();
  const fresh = state?.data !== undefined && now - state.dataUpdatedAt < STALE_MS;
  const failedLately = state?.status === "error" && now - state.errorUpdatedAt < RETRY_AFTER_MS;
  if (!fresh && !failedLately) request(model, ask, queryKey);

  if (state?.data) return state.data;
  // The server couldn't be reached: say so plainly rather than wait forever.
  if (state?.status === "error") return { ...PENDING_PRICE, basis: t("cost.unknown") };
  const last = lastEach.get(model.key);
  return last ? asCount(last, ask.batch) : PENDING_PRICE;
};

function request(model: ModelListItem, ask: PriceAsk, queryKey: readonly unknown[]): void {
  const id = queryKey.join("|");
  if (asking.has(id)) return;
  asking.add(id);
  const { providerId, modelId } = parseModelKey(model.key);
  // After this render: asking can update the cache, which re-renders what's being rendered.
  queueMicrotask(() => {
    void queryClient
      .prefetchQuery({
        queryKey,
        queryFn: async () => {
          const cost = await call(
            api.api.models[":providerId"][":modelId"].estimate.$post({
              param: { providerId, modelId },
              json: ask,
            }),
          );
          if (cost.confidence !== "unknown") lastEach.set(model.key, perImage(cost, ask.batch));
          return cost;
        },
        staleTime: STALE_MS,
        retry: false,
      })
      .finally(() => asking.delete(id));
  });
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

function perImage(estimate: CostEstimate, count: number): CostEstimate {
  const n = Math.max(1, count);
  return { ...estimate, min: round(estimate.min / n), max: round(estimate.max / n) };
}

/** One image's price as `count` of them, while their own answer is on its way. */
function asCount(each: CostEstimate, count: number): CostEstimate {
  return {
    ...each,
    min: round(each.min * count),
    max: round(each.max * count),
    basis: t("cost.basis", { count, each: formatMoney(each.max, each.currency, true) }),
  };
}

// Every answer (or failure) bumps the version, which useModels reads, so prices re-render.
let version = 0;
const listeners = new Set<() => void>();
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.query.queryKey[0] !== ROOT) return;
  if (event.action.type !== "success" && event.action.type !== "error") return;
  version++;
  for (const listener of listeners) listener();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever a company answers a price. */
export function usePriceVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
