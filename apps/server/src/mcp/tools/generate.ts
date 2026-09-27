import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CostEstimate } from "@openfield/core";
import { getJobSet } from "@openfield/db";
import { z } from "zod";
import { approveSpend, checkSpend, priceOf, spendFields, spendMode } from "../guard";
import { guarded, Refusal, reply, type ToolContext } from "../kit";
import { buildRequest, imageRequestFields } from "../request";
import { describeRun } from "../runs";
import { DEFAULT_WAIT_S, waitField, waitForRuns } from "../wait";

// Making images. They land in the person's Image feed like any other run, with the agent's name on
// them in Spending. The limit check and the start happen in one turn (agents.spending), so two
// calls at once can't both slip under the daily limit.

/** A run started, or what to answer instead. */
type Started = { stop: CallToolResult } | { stop?: undefined; runId: string; estimate: CostEstimate };

export function generateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "generate_image",
    {
      title: "Make images",
      description:
        "Makes images with the person's own keys, or edits one (see edit). They appear in Openfield's Image feed as they're made. " +
        "Waits for them (see wait) and answers with a preview of each, its file path and a link to open it in Openfield. " +
        "Costs money: check the price with dryRun or estimate first when making more than one image.",
      inputSchema: { ...imageRequestFields, ...spendFields, wait: waitField },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(ctx, "generate_image", async (args, extra) => {
      const request = await buildRequest(ctx, args);
      const mode = spendMode(ctx, "make_images");
      const count = request.batch === 1 ? "an image" : `${request.batch} images`;
      const asked = await approveSpend(ctx, extra, (await ctx.svc.runner.quote(request)).estimate, args, {
        mode,
        what: `make ${count}`,
      });
      if ("stop" in asked) return asked.stop;
      const started = await ctx.svc.agents.spending(async (): Promise<Started> => {
        const quote = await ctx.svc.runner.quote(request);
        const stop = checkSpend(ctx, quote.estimate, { ...args, confirmCost: asked.confirmCost }, mode);
        if (stop) return { stop };
        const accepted = await ctx.svc.runner.createJobSet(request, { agent: ctx.session.client });
        return { runId: accepted.jobSet.id, estimate: quote.estimate };
      });
      if (started.stop) return started.stop;
      await waitForRuns(ctx, [started.runId], args.wait ?? DEFAULT_WAIT_S, extra);
      const { summary, blocks } = await describeRun(ctx, started.runId, { previews: true });
      return reply({ ...summary, price: priceOf(started.estimate) }, blocks);
    }),
  );

  server.registerTool(
    "recreate",
    {
      title: "Make a run again",
      description:
        "Runs an earlier request again exactly as it was sent (same model, prompt and settings), as a new run. Costs what the original did.",
      inputSchema: {
        runId: z.string().describe("The run to make again, from generate_image, get_job or get_asset."),
        ...spendFields,
        wait: waitField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guarded(ctx, "recreate", async (args, extra) => {
      const set = getJobSet(ctx.svc.db, args.runId);
      if (!set) throw new Refusal(`There's no run with the id ${args.runId}.`);
      // The original's own estimate: the same frozen request, so the same price.
      const usd = set.costEstimateUsd;
      const price: CostEstimate = {
        currency: "USD",
        min: usd ?? 0,
        max: usd ?? 0,
        confidence: usd === null ? "unknown" : "estimated",
        basis: `Same as run ${set.id}`,
        pricedAt: "",
      };
      const mode = spendMode(ctx, "make_images");
      const asked = await approveSpend(ctx, extra, price, args, { mode, what: "make a run again" });
      if ("stop" in asked) return asked.stop;
      const started = await ctx.svc.agents.spending(async (): Promise<Started> => {
        const stop = checkSpend(ctx, price, { ...args, confirmCost: asked.confirmCost }, mode);
        if (stop) return { stop };
        return {
          runId: ctx.svc.runner.recreate(set.id, { agent: ctx.session.client }).jobSet.id,
          estimate: price,
        };
      });
      if (started.stop) return started.stop;
      const { runId } = started;
      await waitForRuns(ctx, [runId], args.wait ?? DEFAULT_WAIT_S, extra);
      const { summary, blocks } = await describeRun(ctx, runId, { previews: true });
      return reply({ ...summary, recreatedFrom: set.id, price: priceOf(price) }, blocks);
    }),
  );
}
