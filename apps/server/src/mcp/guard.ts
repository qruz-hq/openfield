import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type CostEstimate, formatCost, formatMoney } from "@openfield/core";
import { z } from "zod";
import { refuse, reply, type ToolContext } from "./kit";

// The agents' spending limits (Settings > Agents). Every tool that spends runs this first:
// - dryRun: say what it would cost and stop.
// - Past the daily limit: refuse. Runs still going count at their estimate.
// - Above the ask-first amount: refuse until the agent passes confirmCost, which it gets by showing
//   the person the price. A price Openfield can't work out always needs confirmCost.

export const spendFields = {
  dryRun: z.boolean().optional().describe("Only work out the price. Nothing is made or charged."),
  confirmCost: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "The price in USD the person agreed to. Needed when a run costs more than they allow without asking. Show them the price first, then pass it here.",
    ),
};

export interface SpendRequest {
  dryRun?: boolean | undefined;
  confirmCost?: number | undefined;
}

/** The price as agents read it. */
export function priceOf(estimate: CostEstimate) {
  return {
    usd: estimate.confidence === "unknown" ? null : estimate.max,
    ...(estimate.min !== estimate.max && { minUsd: estimate.min }),
    text: formatCost(estimate),
    basis: estimate.basis,
  };
}

/** Whether this price needs the person's OK: above the ask-first amount, or unknown. */
export function needsConfirmCost(ctx: ToolContext, estimate: CostEstimate): boolean {
  return estimate.confidence === "unknown" || estimate.max > ctx.svc.settings.get().agentAskAboveUsd + 1e-9;
}

/** Null to go ahead, or what to answer instead. */
export function checkSpend(
  ctx: ToolContext,
  estimate: CostEstimate,
  req: SpendRequest,
): CallToolResult | null {
  const settings = ctx.svc.settings.get();
  const askAbove = settings.agentAskAboveUsd;
  const cap = settings.agentDailyCapUsd;
  const today = ctx.svc.agents.today();
  const unknown = estimate.confidence === "unknown";
  const cost = estimate.max;
  const needsOk = unknown || cost > askAbove + 1e-9;

  if (req.dryRun) {
    return reply({
      dryRun: true,
      price: priceOf(estimate),
      needsConfirmCost: needsOk,
      spentTodayUsd: today.usd,
      dailyLimitUsd: cap,
    });
  }
  // A price nobody knows can't be checked against what's left, but once nothing is left it waits.
  if (cap !== null && (unknown ? today.usd >= cap - 1e-9 : today.usd + cost > cap + 1e-9)) {
    const costs = unknown
      ? "Openfield can't work out what this costs"
      : `this costs up to ${formatMoney(cost)}`;
    return refuse(
      `This would pass the daily limit for agents: ${formatMoney(cap)}. Agents have spent ${formatMoney(today.usd)} today and ${costs}. ` +
        "The limit starts again at midnight. The person can raise it in Openfield, Settings > Agents.",
    );
  }
  if (needsOk && (req.confirmCost === undefined || (!unknown && req.confirmCost + 1e-9 < cost))) {
    if (unknown) {
      return refuse(
        "Openfield can't work out what this costs for this model. Ask the person if they want to go ahead anyway, then call again with confirmCost set to what they agreed to spend.",
      );
    }
    return refuse(
      `This costs up to ${formatMoney(cost, estimate.currency, true)}, more than the ${formatMoney(askAbove)} the person allows without being asked. ` +
        `Show them the price. If they agree, call again with confirmCost: ${roundUp(cost)}.`,
    );
  }
  return null;
}

/** The smallest confirmCost that covers the price, in a form an agent can copy. */
const roundUp = (usd: number) => Math.ceil(usd * 1000) / 1000;
