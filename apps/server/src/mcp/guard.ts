import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type AgentAction, type CostEstimate, formatCost, formatMoney } from "@openfield/core";
import { z } from "zod";
import { type Extra, refuse, reply, type ToolContext } from "./kit";
import { askPerson, decide, saidNo } from "./permissions";

// The agents' spending limits (Settings > Agents). Every tool that spends runs this first:
// - dryRun: say what it would cost and stop.
// - Past the daily limit: refuse. Runs still going count at their estimate.
// - Needs the person's OK: its action is set to Ask, or to Default and the price is above the
//   ask-first amount or unknown. The app asks them with the price when it can show a prompt
//   (approveSpend); otherwise the agent shows them the price and passes it back as confirmCost.
//   Allow never asks. The daily limit applies either way.

/** Allow, Ask, or Default's own rule (asks above the amount). */
export type SpendMode = "allow" | "ask" | "spend";

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

/** How the person set this spending action. */
export function spendMode(ctx: ToolContext, action: AgentAction): SpendMode {
  const rule = decide(ctx, action);
  return rule === "allow" || rule === "ask" ? rule : "spend";
}

/** Whether this price needs the person's OK. */
export function needsConfirmCost(
  ctx: ToolContext,
  estimate: CostEstimate,
  mode: SpendMode = "spend",
): boolean {
  if (mode === "allow") return false;
  if (mode === "ask") return true;
  return estimate.confidence === "unknown" || estimate.max > ctx.svc.settings.get().agentAskAboveUsd + 1e-9;
}

/**
 * Asks the person in the agent's app, with the price, when this needs their OK and the app can
 * show a prompt. A yes stands in for confirmCost. Nothing to ask, or an app that can't, leaves it
 * to checkSpend.
 */
export async function approveSpend(
  ctx: ToolContext,
  extra: Extra,
  estimate: CostEstimate,
  req: SpendRequest,
  opts: { mode: SpendMode; what: string },
): Promise<{ stop: CallToolResult } | { confirmCost: number | undefined }> {
  if (req.dryRun || !needsConfirmCost(ctx, estimate, opts.mode)) return { confirmCost: req.confirmCost };
  const price =
    estimate.confidence === "unknown"
      ? "at a price Openfield can't work out"
      : `for ${formatCost(estimate).toLowerCase()}`;
  const answer = await askPerson(
    ctx,
    extra,
    `${ctx.session.client} wants to ${opts.what} ${price}. Allow it?`,
  );
  if (answer === "yes") return { confirmCost: estimate.max };
  if (answer === "no") return { stop: saidNo(ctx) };
  return { confirmCost: req.confirmCost };
}

/** Null to go ahead, or what to answer instead. */
export function checkSpend(
  ctx: ToolContext,
  estimate: CostEstimate,
  req: SpendRequest,
  mode: SpendMode = "spend",
): CallToolResult | null {
  const settings = ctx.svc.settings.get();
  const askAbove = settings.agentAskAboveUsd;
  const cap = settings.agentDailyCapUsd;
  const today = ctx.svc.agents.today();
  const unknown = estimate.confidence === "unknown";
  const cost = estimate.max;
  const needsOk = needsConfirmCost(ctx, estimate, mode);

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
    const why =
      mode === "ask"
        ? "The person asked Openfield to check with them before every run like this"
        : `That's more than the ${formatMoney(askAbove)} the person allows without being asked`;
    return refuse(
      `This costs up to ${formatMoney(cost, estimate.currency, true)}. ${why}. ` +
        `Show them the price. If they agree, call again with confirmCost: ${roundUp(cost)}.`,
    );
  }
  return null;
}

/** The smallest confirmCost that covers the price, in a form an agent can copy. */
const roundUp = (usd: number) => Math.ceil(usd * 1000) / 1000;
