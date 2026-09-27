import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CANVAS_CONFIRM_JOBS,
  CANVAS_RUN_SCOPES,
  type CanvasRunScopeResponse,
  type CanvasRunState,
  formatMoney,
  isTerminalState,
} from "@openfield/core";
import { z } from "zod";
import { actorOf, canvasField, describeCanvasRun, reading, resolveCanvas, waitForCanvasRun } from "../canvas";
import { checkSpend, needsConfirmCost, priceOf, spendFields } from "../guard";
import { guarded, Refusal, refuse, reply, type ToolContext } from "../kit";
import { DEFAULT_WAIT_S, waitField } from "../wait";

// Running canvases, exactly as the Run buttons would: the server compiles the saved canvas with the
// editor's own engine, skips what's already up to date, and open tabs follow the run live. Runs go
// through the agents' limits like generate_image, priced from the same plan.

/** Every run, for finding the latest one. */
const EVER = "1970-01-01T00:00:00.000Z";

type Started = { stop: CallToolResult } | { stop?: undefined; run: CanvasRunScopeResponse };

export function canvasRunTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "run_canvas",
    {
      title: "Run a canvas",
      description:
        "Runs a canvas's image nodes, as the Run buttons do: all of them, one node, a node and everything after it, or a set of nodes. " +
        "Nodes whose settings and inputs haven't changed are skipped for free. Open tabs show the run live. " +
        "Costs money: check with dryRun first. Waits for the images (see wait), then answers with each node's images.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        scope: z
          .enum(CANVAS_RUN_SCOPES)
          .optional()
          .describe(
            '"all" (default), "node" (the first of nodeIds), "downstream" (that node and everything after it) or "selection" (nodeIds).',
          ),
        nodeIds: z.array(z.string()).max(500).optional(),
        includeUpstream: z
          .boolean()
          .optional()
          .describe("With scope node: also run the earlier nodes it needs, if they're out of date."),
        rerun: z
          .boolean()
          .optional()
          .describe("Run even the nodes that are up to date. Each image is billed again."),
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
    guarded(ctx, "run_canvas", async (args, extra) => {
      const canvas = resolveCanvas(ctx, args.canvas);
      const scope = args.scope ?? "all";
      if (scope !== "all" && !args.nodeIds?.length) throw new Refusal(`Scope ${scope} needs nodeIds.`);
      const body = {
        scope,
        nodeIds: args.nodeIds ?? [],
        ...(args.includeUpstream !== undefined && { includeUpstream: args.includeUpstream }),
        ...(args.rerun && { bypassCache: true }),
      };
      const actor = actorOf(ctx);
      const started = await ctx.svc.agents.spending(async (): Promise<Started> => {
        const plan = await ctx.svc.canvasRuns.runScope(canvas.id, { ...body, dryRun: true }, actor);
        const nothing = explainNothing(plan);
        if (nothing) return { stop: nothing };
        if (args.dryRun) {
          const today = ctx.svc.agents.today();
          return {
            stop: reply({
              dryRun: true,
              ...planSummary(plan),
              price: priceOf(plan.estimate),
              needsConfirmCost: needsConfirmCost(ctx, plan.estimate) || plan.jobs > CANVAS_CONFIRM_JOBS,
              spentTodayUsd: today.usd,
              dailyLimitUsd: ctx.svc.settings.get().agentDailyCapUsd,
            }),
          };
        }
        if (plan.jobs > CANVAS_CONFIRM_JOBS && args.confirmCost === undefined) {
          return {
            stop: refuse(
              `This run makes ${plan.jobs} images, each billed separately, for up to ${formatMoney(plan.estimate.max)}. Show the person the price. If they agree, call again with confirmCost.`,
            ),
          };
        }
        const stop = checkSpend(ctx, plan.estimate, args);
        if (stop) return { stop };
        const run = await ctx.svc.canvasRuns.runScope(
          canvas.id,
          { ...body, ...(plan.jobs > CANVAS_CONFIRM_JOBS && { confirmed: true }) },
          actor,
        );
        if (run.runId) {
          // Its later nodes make their job sets only once earlier ones finish: the run holds its
          // whole estimate until it ends.
          ctx.svc.agents.hold(run.runId, run.estimate.confidence === "unknown" ? 0 : run.estimate.max);
          const now = ctx.svc.canvasRuns.state(canvas.id, run.runId);
          if (!now || isTerminalState(now.status)) ctx.svc.agents.release(run.runId);
        }
        return { run };
      });
      if (started.stop) return started.stop;
      const { run } = started;
      const nothing = explainNothing(run);
      if (nothing || !run.runId) return nothing ?? refuse("Nothing ran.");
      await waitForCanvasRun(ctx, canvas.id, run.runId, args.wait ?? DEFAULT_WAIT_S, extra);
      return answerRun(ctx, canvas.id, run.runId, { plan: run });
    }),
  );

  server.registerTool(
    "get_run",
    {
      title: "Check a canvas run",
      description:
        "Where a canvas run is: each node's state, the images it made (with previews), and why any failed. Without runId, the canvas's latest run. wait waits for it to end first.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        runId: z.string().optional(),
        wait: waitField.describe("Seconds to wait for the run to end first. Default 0."),
        previews: z.boolean().optional().describe("Include image previews. Default true."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(ctx, "get_run", async ({ canvas: ref, runId, wait, previews }, extra) => {
      const canvas = resolveCanvas(ctx, ref);
      const id = runId ?? ctx.svc.canvasRuns.list(canvas.id, EVER).at(-1)?.runId;
      if (!id) throw new Refusal(`${canvas.name} hasn't been run yet.`);
      if (!ctx.svc.canvasRuns.state(canvas.id, id))
        throw new Refusal(`${canvas.name} has no run with the id ${id}.`);
      reading(ctx, canvas.id);
      if (wait) await waitForCanvasRun(ctx, canvas.id, id, wait, extra);
      return answerRun(ctx, canvas.id, id, { previews: previews ?? true });
    }),
  );

  server.registerTool(
    "stop_run",
    {
      title: "Stop a canvas run",
      description:
        "Stops a canvas run, or only one node of it and the nodes that read from it. Images already sent to the company may still be charged.",
      inputSchema: {
        canvas: z.string().describe(canvasField),
        runId: z.string(),
        nodeId: z.string().optional().describe("Stop only this node, and what reads from it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(ctx, "stop_run", async ({ canvas: ref, runId, nodeId }) => {
      const canvas = resolveCanvas(ctx, ref);
      if (!ctx.svc.canvasRuns.state(canvas.id, runId))
        throw new Refusal(`${canvas.name} has no run with the id ${runId}.`);
      if (nodeId) ctx.svc.canvasRuns.cancelNode(canvas.id, runId, nodeId);
      else ctx.svc.canvasRuns.cancel(canvas.id, runId);
      return answerRun(ctx, canvas.id, runId, {
        previews: false,
        note: "Stopped. Anything the company had already started may still be charged.",
      });
    }),
  );
}

/** What a plan covers, in the words an agent needs to act on it. */
function planSummary(plan: CanvasRunScopeResponse) {
  return {
    images: plan.jobs,
    runs: plan.planned,
    ...(plan.upToDate.length > 0 && { upToDate: plan.upToDate }),
    ...(plan.blocked.length > 0 && {
      blocked: plan.blocked.map((b) => ({ nodeId: b.nodeId, why: b.message })),
    }),
  };
}

/** A plan that runs nothing, said plainly; null when there's something to run. */
function explainNothing(plan: CanvasRunScopeResponse): CallToolResult | null {
  if (plan.outcome === "busy") return refuse("Those nodes are already running. Call get_run to follow them.");
  if (plan.outcome === "needs_upstream") {
    return refuse(
      `Earlier nodes this one reads from need to run first: ${plan.upstream.join(", ")}. Call again with includeUpstream: true to run them too.`,
    );
  }
  if (plan.jobs > 0) return null;
  const blocked = plan.blocked.map((b) => `${b.nodeId}: ${b.message}`);
  if (blocked.length) return refuse(`Nothing can run yet. ${blocked.join(" ")}`);
  if (plan.upToDate.length) {
    return reply({
      ran: false,
      upToDate: plan.upToDate,
      note: "Everything asked for is up to date, so nothing ran and nothing was charged. Pass rerun: true to make new images anyway.",
    });
  }
  return refuse("There's nothing to run: no image nodes in what was asked for.");
}

async function answerRun(
  ctx: ToolContext,
  canvasId: string,
  runId: string,
  opts: { previews?: boolean; plan?: CanvasRunScopeResponse; note?: string },
): Promise<CallToolResult> {
  const state = ctx.svc.canvasRuns.state(canvasId, runId) as CanvasRunState;
  const { view, blocks } = await describeCanvasRun(ctx, state, { previews: opts.previews ?? true });
  return reply(
    {
      ...view,
      ...(opts.note && { note: opts.note }),
      ...(opts.plan && {
        price: priceOf(opts.plan.estimate),
        ...(opts.plan.upToDate.length > 0 && { skippedUpToDate: opts.plan.upToDate }),
        ...(opts.plan.blocked.length > 0 && {
          blocked: opts.plan.blocked.map((b) => ({ nodeId: b.nodeId, why: b.message })),
        }),
      }),
    },
    blocks,
  );
}
