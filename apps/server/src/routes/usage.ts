import { zValidator } from "@hono/zod-validator";
import { DEFAULT_CURRENCY, type UsageResponse, type UsageRow, usageQuerySchema } from "@openfield/core";
import { usageRollup } from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

// Tracked on this computer; the bill from each company is the real figure (§6.9).
export const usageRoutes = new Hono<Env>().get(
  "/usage",
  zValidator("query", usageQuerySchema, onInvalid),
  (c) => {
    const { from, to, groupBy } = c.req.valid("query");
    const rows = usageRollup(c.var.svc.db, { from: from ?? "1970-01-01T00:00:00.000Z", ...(to && { to }) });

    const grouped = new Map<string, UsageRow>();
    for (const row of rows) {
      const key =
        groupBy === "day"
          ? row.day
          : groupBy === "model"
            ? `${row.providerId}:${row.modelId}`
            : row.providerId;
      const into = grouped.get(key) ?? {
        ...(groupBy === "day" && { day: row.day }),
        ...(groupBy !== "day" && { providerId: row.providerId }),
        ...(groupBy === "model" && { modelId: row.modelId }),
        runs: 0,
        images: 0,
        usd: 0,
        usdDiscarded: 0,
        reruns: 0,
      };
      into.runs += row.runs;
      into.images += row.images;
      into.usd = round(into.usd + row.usd);
      into.usdDiscarded = round(into.usdDiscarded + row.usdDiscarded);
      // Images that ran again after a restart: the first call may be billed too (§0.13).
      into.reruns = (into.reruns ?? 0) + (row.reruns ?? 0);
      grouped.set(key, into);
    }
    const items = [...grouped.values()];
    const body: UsageResponse = {
      rows: items,
      totalUsd: round(items.reduce((sum, r) => sum + r.usd, 0)),
      discardedUsd: round(items.reduce((sum, r) => sum + r.usdDiscarded, 0)),
      currency: DEFAULT_CURRENCY,
    };
    return c.json(body satisfies UsageResponse, 200);
  },
);
